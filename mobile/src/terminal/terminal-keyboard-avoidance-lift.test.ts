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
  })

  it('uses the platform-adjusted lift proportionally on iOS and Android', () => {
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
})
