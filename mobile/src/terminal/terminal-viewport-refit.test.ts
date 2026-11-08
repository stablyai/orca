import { describe, expect, it } from 'vitest'

import { reduceTerminalFrameHeightRefit } from './terminal-viewport-refit-state'

describe('terminal viewport refit', () => {
  it('re-defers a height refit if the keyboard reopens before the debounce fires', () => {
    let r = reduceTerminalFrameHeightRefit(
      { frameHeight: 600, keyboardVisible: true, pending: false },
      { type: 'frame-height', height: 520 }
    )
    expect(r.shouldRefit).toBe(false)
    expect(r.state.pending).toBe(true)

    r = reduceTerminalFrameHeightRefit(r.state, { type: 'keyboard-visibility', visible: false })
    expect(r.shouldRefit).toBe(true)

    // Reopen inside debounce; the timer must preserve the pending refit instead of reflowing while typing.
    r = reduceTerminalFrameHeightRefit(r.state, { type: 'keyboard-visibility', visible: true })
    const committed = reduceTerminalFrameHeightRefit(r.state, { type: 'refit-committed' })
    expect(committed.shouldRefit).toBe(false)
    expect(committed.state.pending).toBe(true)

    const rescheduled = reduceTerminalFrameHeightRefit(committed.state, {
      type: 'keyboard-visibility',
      visible: false
    })
    expect(rescheduled.shouldRefit).toBe(true)
    const ran = reduceTerminalFrameHeightRefit(rescheduled.state, { type: 'refit-committed' })
    expect(ran.shouldRefit).toBe(true)
    expect(ran.state.pending).toBe(false)
  })
})
