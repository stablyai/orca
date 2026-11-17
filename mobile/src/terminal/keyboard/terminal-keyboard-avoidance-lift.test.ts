import { describe, expect, it } from 'vitest'

import { computeActiveTerminalKeyboardLift } from './terminal-keyboard-avoidance-lift'
import { parseTerminalKeyboardAvoidanceMetrics } from '../webview/terminal-webview-contract'
import type { TerminalKeyboardAvoidanceMetrics } from '../webview/terminal-webview-contract'

const FRAME_HEIGHT = 800
const ROWS = 40
const KEYBOARD_LIFT = 300

function metrics(
  overrides: Partial<TerminalKeyboardAvoidanceMetrics> = {}
): TerminalKeyboardAvoidanceMetrics {
  return { cursorY: 0, contentBottomRow: 0, rows: ROWS, altScreen: false, ...overrides }
}

describe('computeActiveTerminalKeyboardLift', () => {
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
      const phone = metrics({ rows: 47, rowPitch: 15, cursorY: 46, contentBottomRow: 46 })
      expect(lift(312, phone)).toBe(312)
    })

    it('lifts a desktop-mode grid only by what the keyboard hides of it', () => {
      const drawn270 = metrics({ rows: 40, rowPitch: 6.75, cursorY: 39, contentBottomRow: 39 })
      expect(lift(312, drawn270)).toBe(0)
      expect(lift(312, { ...drawn270, altScreen: true })).toBe(0)
      const drawn425 = metrics({ rows: 50, rowPitch: 8.5, cursorY: 49, contentBottomRow: 49 })
      expect(lift(312, drawn425)).toBeCloseTo(23.3, 5)
      expect(lift(312, { ...drawn425, altScreen: true })).toBeCloseTo(23.3, 5)
      expect(lift(312, { ...drawn425, cursorY: 46, contentBottomRow: 46 })).toBeCloseTo(6.3, 5)
      expect(lift(312, { ...drawn425, cursorY: 45, contentBottomRow: 45 })).toBe(0)
    })

    it('stays under the strip while stale rows outlast a rotation or a text-size change', () => {
      const rotated = metrics({ rows: 47, rowPitch: 15, cursorY: 46, contentBottomRow: 46 })
      expect(lift(150, rotated, 300)).toBe(150)
      const resized = metrics({ rows: 47, rowPitch: 18, cursorY: 46, contentBottomRow: 46 })
      expect(lift(312, resized)).toBe(312)
    })
  })
})
