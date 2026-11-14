import { describe, expect, it } from 'vitest'
import { countRecurringTimers } from './check-recurring-timer-ratchet.mjs'

describe('recurring-timer ratchet', () => {
  it.each([
    ['window.setInterval(poll, 1)\nglobalThis.setInterval(poll, 1)\nobj.setInterval(1)', 2],
    [
      "import { setInterval } from 'node:timers'\nsetInterval(poll, 1)\nwindow.setInterval(poll, 1)",
      2
    ],
    ["import { setInterval as every } from 'node:timers/promises'\nevery(5000)", 1],
    ["const { setInterval } = await import('node:timers')\nsetInterval(poll, 1)", 1],
    ['function a(setInterval) { setInterval(f) }\nfunction b() { setInterval(g, 1) }', 1],
    ['function setInterval(f) {}\nsetInterval(poll)', 0],
    ["if (typeof setInterval === 'function') {}\ntype T = typeof setInterval", 0],
    ["setInterval = replacement\nwindow['setInterval'] = replacement\ntypeof (setInterval)", 0],
    ['(window.setInterval ||= fallback)(poll, 1000)', 1]
  ])('counts %s', (source, count) => {
    expect(countRecurringTimers('src/main/example.ts', source)).toBe(count)
  })
})
