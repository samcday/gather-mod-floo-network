const { Game } = require("@gathertown/gather-game-client");
const {SimilarSearch} = require('node-nlp');

global.WebSocket = require("isomorphic-ws");

// https://stackoverflow.com/a/18157551
function distance(obj, p) {
  var dx = Math.max(obj.x - p.x, 0, p.x - (obj.x + obj.width));
  var dy = Math.max(obj.y - p.y, 0, p.y - (obj.y + obj.height));
  return Math.sqrt(dx*dx + dy*dy);
}

const game = new Game(process.env.GATHER_SPACE_ID, () => Promise.resolve({ apiKey: process.env.GATHER_API_KEY }));

(async function() {
  game.connect();
  await game.waitForInit();

  while(true) {
    // Lit fireplaces need special care when they exist.
    for (const mapId of game.getKnownCompletedMaps()) {
      const litFireplaces = game.filterObjectsInMap(mapId, (obj) => obj.templateId && obj.templateId.startsWith("Fireplacelit -") && obj._tags.includes("floo"));
      let totalLit = litFireplaces.length;
      for (const obj of litFireplaces) {
        const state = JSON.parse(obj.customState);
        // Lit fireplaces will self-extinguish after 10sec of inactivity.
        // ... Except keep at least one fireplace lit. Public game client acts strangely when a private area disappears completely.
        if (totalLit > 1 && Date.now() - 10000 > state.lastActivity) {
          console.log('unlighting fireplace', obj);
          obj.templateId = 'Fireplace - wMX-BazJtzaaBYUQoEczy';
          obj._name = 'Fireplace (unlit)';
          obj.customState = '';
          obj.normal = 'https://cdn.gather.town/storage.googleapis.com/gather-town.appspot.com/internal-dashboard/images/KgU9aM0sBapJtV_8NYpRn';
          obj.highlighted = 'https://cdn.gather.town/storage.googleapis.com/gather-town.appspot.com/internal-dashboard/images/OK69nD5SeHfZPWXbapiBT';
          obj.previewMessage = '';
          obj.distThreshold = 0;
          obj.type = 0;
          obj.sound = undefined;
          game.setMapObjects(mapId, {
            [obj.key]: obj,
          }, true);
          totalLit -= 1;
        }
      }
      await checkFireplaceSpaces(mapId);
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }
})().catch(console.error);

async function checkFireplaceSpaces(mapId) {
  // The Floo Network private area should only exist where lit fireplaces are.
  let areaPos = [];
  for (const obj of game.filterObjectsInMap(mapId, (obj) => obj.templateId && obj.templateId.startsWith("Fireplacelit -"))) {
    for (let x = obj.x - 1; x < obj.x + obj.width + 1; x++) {
      for (let y = obj.y - 1; y < obj.y + obj.height + 1; y++) {
        areaPos.push({x, y});
      }
    }
  }

  const mapSpaces = JSON.parse(JSON.stringify(game.partialMaps[mapId].spaces));
  mapSpaces.sort();
  const newMapSpaces = mapSpaces.filter(space => {
    if (space.spaceId != 'Floo Network') {
      return true;  
    }
    const idx = areaPos.findIndex(pos => pos.x == space.x && pos.y == space.y);
    if (idx > -1) {
      areaPos.splice(idx, 1);
      return true;
    }
    return false;
  });
  for (const {x, y} of areaPos) {
    newMapSpaces.push({spaceId: 'Floo Network', x, y, colored: false});
  }

  if (JSON.stringify(mapSpaces) !== JSON.stringify(newMapSpaces)) {
    console.log('updating spaces for map', mapId, newMapSpaces.filter(space => space.spaceId == 'Floo Network'));
    await game.setMapSpaces(mapId, newMapSpaces);
    game.partialMaps[mapId].spaces = newMapSpaces;
  }
}

// Shooting confetti near unlit fireplaces will cause them to become lit fireplaces.
async function lightFireplace(mapId, obj) {
  if (obj.templateId.startsWith('Fireplacelit -')) {
    return;
  }

  obj.templateId = 'Fireplacelit - bXTfxuPYvb3QCv70un-Rf';
  obj._name = '🔊 Fireplace (lit)';
  let state = {};
  try {
    state = JSON.parse(obj.customState);
  } catch(err) {}
  state.lastActivity = Date.now();
  obj.customState = JSON.stringify(state);
  obj.normal = 'https://cdn.gather.town/storage.googleapis.com/gather-town.appspot.com/internal-dashboard/images/Ze-uC162NGOkJVcvwrlx7';
  obj.highlighted = 'https://cdn.gather.town/storage.googleapis.com/gather-town.appspot.com/internal-dashboard/images/QXivlumosa2Syt_BL7ScD';
  obj.previewMessage = `Not connected to Floo Network`;
  obj.properties.message = "Try saying the name of a place you'd like to travel to in chat. (Hint: the place you want to go needs to have a fireplace)";
  obj.distThreshold = 1;
  obj.type = 6;
  obj._tags = obj._tags || [];
  if (!obj._tags.includes("floo")) obj._tags.push("floo");
  obj.sound = {
    src: 'https://cdn.gather.town/storage.googleapis.com/gather-town.appspot.com/internal-dashboard/sounds/BuHpL3aHEyvdbC9bhxsAA',
    volume: 0.5,
    loop: true,
    maxDistance: 5,
    isPositional: false
  };
  await game.setMapObjects(mapId, {
    [obj.key]: obj,
  }, true);
  await checkFireplaceSpaces(mapId);
}

game.subscribeToEvent("playerShootsConfetti", async (_, context) => {
  try {
    for (const obj of game.filterObjectsInMap(context.player.map, (obj) => obj.templateId && obj.templateId.startsWith("Fireplace -"))) {
      if (distance(obj, context.player) <= 1) {
        await lightFireplace(context.player.map, obj);
      }
    }
  } catch(err) {
    console.error(err);
  }
});

// If a player says something in local chat whilst near a fireplace, it will set the destination of that fireplace.
const similar = new SimilarSearch();
game.subscribeToEvent("playerChats", async (data, context) => {
  if (data.playerChats.recipient != "LOCAL_CHAT") {
    return;
  }
  if (!game.isPlayerInPrivateSpace(context.player, context.player.map, "Floo Network")) {
    return;
  }

  for (const obj of game.filterObjectsInMap(context.player.map, (obj) => obj.templateId && obj.templateId.startsWith("Fireplacelit -"))) {
    if (distance(obj, context.player) > 1) {
      continue;
    }
    const msg = data.playerChats.contents;
    const mapIds = game.getKnownCompletedMaps();
    let pick = mapIds.shift();
    let lowScore = similar.getSimilarity(msg, pick);
    for (const mapId of mapIds) {
      const score = similar.getSimilarity(msg, mapId); 
      if (score < lowScore) {
        lowScore = score;
        pick = mapId;
      }
    }
    // Iterate objects in pick, find all fireplaces.
    const targetFireplaces = game.filterObjectsInMap(pick, (obj) => obj.templateId && obj.templateId.startsWith("Fireplace"));
    if (!targetFireplaces) {
      // TODO: What to do here?
      return;
    }
    const alreadyLit = targetFireplaces.filter(obj => obj.templateId.startsWith("Fireplacelit -"));
    const target = alreadyLit.length ? alreadyLit[Math.floor(Math.random() * alreadyLit.length)] : targetFireplaces[Math.floor(Math.random() * targetFireplaces.length)];
    const state = JSON.parse(obj.customState);
    state.targetMapId = pick;
    state.targetObj = target.id;
    obj.previewMessage = `Floo Network connected to ${target.id} in ${pick}`;
    obj.properties.message = "Try walking through this fireplace while in ghost mode (hold down the 'g' button while walking) and see what happens!";
    obj.distThreshold = 1;
    obj.type = 6;
    obj.customState = JSON.stringify(state);
    await game.setMapObjects(context.player.map, {
      [obj.key]: obj,
    }, true);
    return;
  }
});

// If a player moves while in ghost mode and near a lit fireplace, they will be teleported.
// If the fireplace already has a target set, it will be used.
// If not, a random fireplace anywhere in the entire server will be chosen.
// When teleported to fireplace, it will be lit if it wasn't already, its expiration will also be reset.
// I think I use game.teleport()
game.subscribeToEvent("playerMoves", async (data, context) => {
  if (!game.isPlayerInPrivateSpace(context.player, context.player.map, "Floo Network")) {
    return;
  }
  if (!context.player.ghost) {
    return;
  }

  for (const obj of game.filterObjectsInMap(context.player.map, (obj) => obj._tags && obj._tags.includes("floo") && obj.templateId && obj.templateId.startsWith("Fireplacelit -"))) {
    if (distance(obj, context.player) > 1) {
      continue;
    }
    const state = JSON.parse(obj.customState);

    if (state.lastActivity > Date.now() - 500) {
      return;
    }

    const target = game.getObject(state.targetObj, state.targetMapId);
    if (!target) {
      // TODO: hmm? pick any random fireplace in any map, I guess.
      return;
    }

    // Find a passable tile position near the target.
    let tries = 1000;
    let x = target.obj.x;
    let y = target.obj.y + target.obj.height;
    while(tries-- > 0) {
      if (!game.getImpassable(target.mapId, x, y)) {
        break;
      }
      x += 1;
      if (x > target.obj.x + target.obj.width) {
        x = target.obj.x;
        y += 1;
      }
    }

    if (tries <= 0) {
      // Oh well we tried.
      return;
    }

    await lightFireplace(target.mapId, target.obj);

    // Set when both fireplaces were last used, we debounce mainly to prevent a player moving through the fireplace from teleporting again through the destination fireplace.
    // But this also conveniently resets the timer for a fireplace to go idle.
    state.lastActivity = Date.now();
    obj.customState = JSON.stringify(state);
    await game.setMapObjects(context.player.map, {
      [obj.key]: obj,
    }, true);

    const targetState = JSON.parse(target.obj.customState);
    targetState.lastActivity = Date.now();
    target.obj.customState = JSON.stringify(targetState);
    await game.setMapObjects(target.mapId, {
      [target.obj.key]: target.obj,
    }, true);

    await game.teleport(state.targetMapId, x, y, context.player.id);

    return;
  }
});
 