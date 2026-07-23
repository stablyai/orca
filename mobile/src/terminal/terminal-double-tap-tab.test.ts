import { describe, expect, it } from 'vitest'
import {
  TERMINAL_DOUBLE_TAP_TAB_MAX_DELAY_MS,
  resolveTerminalDoubleTapTab
} from './terminal-double-tap-tab'

describe('terminal double-tap Tab', () => {
  it('stays inactive when the preference is disabled', () => {
    expect(
      resolveTerminalDoubleTapTab({
        enabled: false,
        handle: 'term-1',
        lastTap: { handle: 'term-1', at: 100 },
        now: 200
      })
    ).toEqual({ sendTab: false, nextTap: null })
  })

  it('sends Tab for a second tap on the same terminal within the window', () => {
    expect(
      resolveTerminalDoubleTapTab({
        enabled: true,
        handle: 'term-1',
        lastTap: { handle: 'term-1', at: 100 },
        now: 100 + TERMINAL_DOUBLE_TAP_TAB_MAX_DELAY_MS
      })
    ).toEqual({ sendTab: true, nextTap: null })
  })

  it('starts a new tap sequence after the window expires', () => {
    expect(
      resolveTerminalDoubleTapTab({
        enabled: true,
        handle: 'term-1',
        lastTap: { handle: 'term-1', at: 100 },
        now: 101 + TERMINAL_DOUBLE_TAP_TAB_MAX_DELAY_MS
      })
    ).toEqual({
      sendTab: false,
      nextTap: { handle: 'term-1', at: 101 + TERMINAL_DOUBLE_TAP_TAB_MAX_DELAY_MS }
    })
  })

  it('does not combine taps across terminal switches or clock reversal', () => {
    expect(
      resolveTerminalDoubleTapTab({
        enabled: true,
        handle: 'term-2',
        lastTap: { handle: 'term-1', at: 100 },
        now: 200
      }).sendTab
    ).toBe(false)

    expect(
      resolveTerminalDoubleTapTab({
        enabled: true,
        handle: 'term-1',
        lastTap: { handle: 'term-1', at: 200 },
        now: 100
      }).sendTab
    ).toBe(false)
  })
})
