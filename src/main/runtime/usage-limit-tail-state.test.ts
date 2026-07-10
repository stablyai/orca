import { describe, expect, it } from 'vitest'
import { computeTerminalTailWaitState, tailGainedNewerUsageLimitStall } from './orca-runtime'

function stateFor(text: string) {
  return computeTerminalTailWaitState([text], '', text)
}

describe('usage-limit tail-state edge trigger', () => {
  it('exposes a usage-limit signal on the memoized wait state', () => {
    const state = stateFor("You've hit your session limit · resets 3:50pm")
    expect(state.usageLimitSignal?.reason).toBe('usage-limit-banner')
  })

  it('fires once when a fresh stall appears in the appended chunk', () => {
    const before = stateFor('working on it…')
    const appended = "\nYou've hit your session limit · resets 3:50pm"
    const after = computeTerminalTailWaitState(
      ['working on it…', "You've hit your session limit · resets 3:50pm"],
      '',
      ''
    )
    expect(tailGainedNewerUsageLimitStall(before, after, appended)).toBe(true)
  })

  it('does not re-fire on stale banner text already in the previous tail', () => {
    const banner = "You've hit your session limit · resets 3:50pm"
    const before = stateFor(banner)
    // A later spinner redraw chunk with no new limit line must not re-arm.
    const after = computeTerminalTailWaitState([banner, '⠋ thinking'], '', '')
    expect(tailGainedNewerUsageLimitStall(before, after, '\n⠋ thinking')).toBe(false)
  })
})
