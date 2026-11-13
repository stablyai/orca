import { expect, it } from 'vitest'
import { shouldActivateOpenedMobileSessionTab } from './opened-mobile-session-tab'

it('refuses a completion whose host authority is no longer current', () => {
  const state = {
    activated: false,
    activationSeq: 1,
    latestActivationSeq: 1,
    sourceTerminalHandle: 'terminal-1',
    activeTerminalHandle: 'terminal-1',
    activeTabType: 'terminal'
  }

  expect(shouldActivateOpenedMobileSessionTab(state)).toBe(true)
  expect(shouldActivateOpenedMobileSessionTab({ ...state, sourceAuthorityCurrent: false })).toBe(
    false
  )
})
