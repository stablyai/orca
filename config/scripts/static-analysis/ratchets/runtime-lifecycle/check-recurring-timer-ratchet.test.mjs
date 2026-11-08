import { describe, expect, it } from 'vitest'
import { countRecurringTimers } from './check-recurring-timer-ratchet.mjs'

describe('recurring-timer ratchet', () => {
  it.each([
    ['setInterval(poll, 1000)', 1],
    ['window.setInterval(poll, 1)\nglobalThis.setInterval(poll, 1)\nobj.setInterval(1)', 2],
    [
      "import { setInterval } from 'node:timers'\nsetInterval(poll, 1)\nwindow.setInterval(poll, 1)",
      2
    ],
    ["const { setInterval } = require('node:timers')\nsetInterval(poll, 1)", 1],
    ["import { setInterval as every } from 'node:timers/promises'\nevery(5000)", 1],
    // Alias and destructure forms of an imported timer count once, like the direct call.
    [
      "import * as timers from 'node:timers'\nconst setInterval = timers.setInterval\nsetInterval(poll, 1)",
      1
    ],
    [
      "const timers = require('node:timers')\nconst { setInterval } = timers\nsetInterval(poll, 1)",
      1
    ],
    ["const { setInterval } = await import('node:timers')\nsetInterval(poll, 1)", 1],
    // An unrelated local binding must not hide a global poll elsewhere in the file.
    ['function configure(setInterval) {\n  return setInterval\n}\nsetInterval(poll, 1000)', 1],
    ['type Configure = (setInterval: number) => void\nsetInterval(poll, 1000)', 1],
    ['function a(setInterval) { setInterval(f) }\nfunction b() { setInterval(g, 1) }', 1],
    ['function setInterval(f) {}\nsetInterval(poll)', 0]
  ])('counts %s', (source, count) => {
    expect(countRecurringTimers('src/main/example.ts', source)).toBe(count)
  })
})
