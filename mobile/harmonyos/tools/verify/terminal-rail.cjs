const test = require('node:test')
const assert = require('node:assert/strict')
const { loadArkts } = require('./arkts-source.cjs')

const terminalRail = require('../../entry/src/main/ets/vendor/terminal-rail.js')
const { projectSideRail } = loadArkts('webshell/WindowRegions.ets', ['projectSideRail'], {
  terminalRail
})

// Display cutouts are read in window coordinates without clipping, so they can reach past the window.
test('keeps the side rail beside a cutout that reaches past the bottom of the window', () => {
  const frame = { x: 0, y: 0, width: 800, height: 800 }
  const strip = terminalRail.getSideRailStrip({
    windowWidth: frame.width,
    windowHeight: frame.height,
    insets: { top: 0, right: 84, bottom: 34, left: 0 },
    occlusions: [
      { x: 716, y: 0, width: 84, height: 40 },
      { x: 716, y: 650, width: 84, height: 20 },
      { x: 716, y: 1400, width: 84, height: 20 }
    ]
  })
  // What ShellWindowRegions.readRail publishes for a strip.
  const rail = strip && {
    side: strip.side,
    region: {
      x: strip.side === 'left' ? 0 : frame.width - strip.width,
      y: strip.top,
      width: strip.width,
      height: strip.height
    }
  }

  // The strip comes from another realm, so its fields are compared one by one.
  const projected = projectSideRail({ occlusions: [], creases: [], rail }, frame)
  assert.equal(projected?.side, 'right')
  assert.equal(projected?.width, 84)
  assert.equal(projected?.height, 610)
  assert.equal(projected?.top, 40)
  assert.equal(projected?.bottom, 150)
})
