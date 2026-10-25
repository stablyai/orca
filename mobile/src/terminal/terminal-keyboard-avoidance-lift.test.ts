import { describe, expect, it } from 'vitest'

import { computeActiveTerminalKeyboardLift } from './terminal-keyboard-avoidance-lift'
import { parseTerminalKeyboardAvoidanceMetrics } from './terminal-webview-contract'
import type { TerminalKeyboardAvoidanceMetrics } from './terminal-webview-contract'

const FRAME_HEIGHT = 800
const ROWS = 40
const KEYBOARD_LIFT = 300

function metrics(
  overrides: Partial<TerminalKeyboardAvoidanceMetrics> = {}
): TerminalKeyboardAvoidanceMetrics {
  return { cursorY: 0, contentBottomRow: 0, rows: ROWS, altScreen: false, ...overrides }
}

describe('computeActiveTerminalKeyboardLift', () => {
  it('returns 0 when the keyboard is closed', () => {
    expect(
      computeActiveTerminalKeyboardLift({
        keyboardLift: 0,
        metrics: metrics({ cursorY: 30, contentBottomRow: 34 }),
        terminalFrameHeight: FRAME_HEIGHT
      })
    ).toBe(0)
  })

  it('falls back to the full lift when metrics are missing', () => {
    expect(
      computeActiveTerminalKeyboardLift({
        keyboardLift: KEYBOARD_LIFT,
        metrics: undefined,
        terminalFrameHeight: FRAME_HEIGHT
      })
    ).toBe(KEYBOARD_LIFT)
  })

  it('falls back to the full lift when rows or frame height are unmeasured', () => {
    expect(
      computeActiveTerminalKeyboardLift({
        keyboardLift: KEYBOARD_LIFT,
        metrics: metrics({ rows: 0 }),
        terminalFrameHeight: FRAME_HEIGHT
      })
    ).toBe(KEYBOARD_LIFT)
    expect(
      computeActiveTerminalKeyboardLift({
        keyboardLift: KEYBOARD_LIFT,
        metrics: metrics(),
        terminalFrameHeight: 0
      })
    ).toBe(KEYBOARD_LIFT)
  })

  it('lifts fully for alt-screen TUIs', () => {
    expect(
      computeActiveTerminalKeyboardLift({
        keyboardLift: KEYBOARD_LIFT,
        metrics: metrics({ cursorY: 10, contentBottomRow: 10, altScreen: true }),
        terminalFrameHeight: FRAME_HEIGHT
      })
    ).toBe(KEYBOARD_LIFT)
  })

  it('clears a main-buffer footer while an old payload retains cursor-only behavior', () => {
    const candidate = computeActiveTerminalKeyboardLift({
      keyboardLift: KEYBOARD_LIFT,
      metrics: metrics({ cursorY: 30, contentBottomRow: 34 }),
      terminalFrameHeight: FRAME_HEIGHT
    })
    const oldPayload = parseTerminalKeyboardAvoidanceMetrics({ cursorY: 30, rows: ROWS })
    const cursorOnly = computeActiveTerminalKeyboardLift({
      keyboardLift: KEYBOARD_LIFT,
      metrics: oldPayload,
      terminalFrameHeight: FRAME_HEIGHT
    })
    expect({ candidate, cursorOnly }).toEqual({ candidate: 220, cursorOnly: 140 })
  })

  it('keeps short output near the top put (no lift)', () => {
    expect(
      computeActiveTerminalKeyboardLift({
        keyboardLift: KEYBOARD_LIFT,
        metrics: metrics({ cursorY: 2, contentBottomRow: 5 }),
        terminalFrameHeight: FRAME_HEIGHT
      })
    ).toBe(0)
  })

  it('matches cursor-clearing behavior for a scrolled shell (prompt at the bottom)', () => {
    const lift = computeActiveTerminalKeyboardLift({
      keyboardLift: KEYBOARD_LIFT,
      metrics: metrics({ cursorY: 38, contentBottomRow: 38 }),
      terminalFrameHeight: FRAME_HEIGHT
    })
    expect(lift).toBe(KEYBOARD_LIFT)
  })

  it('never exceeds the keyboard lift', () => {
    const lift = computeActiveTerminalKeyboardLift({
      keyboardLift: KEYBOARD_LIFT,
      metrics: metrics({ cursorY: 39, contentBottomRow: 39 }),
      terminalFrameHeight: FRAME_HEIGHT
    })
    expect(lift).toBeLessThanOrEqual(KEYBOARD_LIFT)
    // With the drawn row pitch too, and a grid drawn taller than the frame it is lifted in.
    const taller = computeActiveTerminalKeyboardLift({
      keyboardLift: KEYBOARD_LIFT,
      metrics: metrics({ rows: 60, rowPitch: 18, cursorY: 59, contentBottomRow: 59 }),
      terminalFrameHeight: FRAME_HEIGHT
    })
    expect(taller).toBe(KEYBOARD_LIFT)
  })

  it('applies the supplied keyboard coverage to the lift', () => {
    const tuiMetrics = metrics({ cursorY: 30, contentBottomRow: 34 })
    const android = computeActiveTerminalKeyboardLift({
      keyboardLift: 300,
      metrics: tuiMetrics,
      terminalFrameHeight: FRAME_HEIGHT
    })
    const ios = computeActiveTerminalKeyboardLift({
      keyboardLift: 266,
      metrics: tuiMetrics,
      terminalFrameHeight: FRAME_HEIGHT
    })
    expect({ android, ios }).toEqual({ android: 220, ios: 186 })
  })

  describe('a keyboard that covers the frame', () => {
    const lift = (keyboardLift: number, m: TerminalKeyboardAvoidanceMetrics, frame = 713.7) =>
      computeActiveTerminalKeyboardLift({
        keyboardLift,
        metrics: m,
        terminalFrameHeight: frame
      })

    it('keeps base in phone mode, where the fit fills the frame to within a row', () => {
      // Pixel_API_37: 47 rows of 15 px in a 713.7 px frame under a 312 px keyboard.
      const phone = metrics({ rows: 47, rowPitch: 15, cursorY: 46, contentBottomRow: 46 })
      expect(lift(312, phone)).toBe(312)
    })

    it('lifts a desktop-mode grid only by what the keyboard hides of it', () => {
      // Pixel_API_37, measured blank: 40 desktop rows drawn 270 px tall, lifted 312 under the header.
      const drawn270 = metrics({ rows: 40, rowPitch: 6.75, cursorY: 39, contentBottomRow: 39 })
      expect(lift(312, drawn270)).toBe(0)
      expect(lift(312, { ...drawn270, altScreen: true })).toBe(0)
      // 425 px drawn, the dock at 401.7: the caret row's bottom lands on the dock.
      const drawn425 = metrics({ rows: 50, rowPitch: 8.5, cursorY: 49, contentBottomRow: 49 })
      expect(lift(312, drawn425)).toBeCloseTo(23.3, 5)
      expect(lift(312, { ...drawn425, altScreen: true })).toBeCloseTo(23.3, 5)
      // A caret mid-grid lifts only enough to clear its row plus one: 47 x 8.5 + 8.5 - 401.7.
      expect(lift(312, { ...drawn425, cursorY: 46, contentBottomRow: 46 })).toBeCloseTo(6.3, 5)
      expect(lift(312, { ...drawn425, cursorY: 45, contentBottomRow: 45 })).toBe(0)
    })

    it('lifts nothing for a keyboard that is open and covers nothing', () => {
      expect(lift(0, metrics({ rows: 50, rowPitch: 17, cursorY: 49, contentBottomRow: 49 }))).toBe(
        0
      )
    })

    it('stays under the strip while stale rows outlast a rotation or a text-size change', () => {
      const rotated = metrics({ rows: 47, rowPitch: 15, cursorY: 46, contentBottomRow: 46 })
      expect(lift(150, rotated, 300)).toBe(150)
      const resized = metrics({ rows: 47, rowPitch: 18, cursorY: 46, contentBottomRow: 46 })
      expect(lift(312, resized)).toBe(312)
    })
  })
})
