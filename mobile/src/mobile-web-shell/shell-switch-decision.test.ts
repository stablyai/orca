import { describe, expect, it } from 'vitest'
import { shellSwitchDecision } from './shell-switch-decision'

const ROUTE = { pathname: '/h/host-1/files/wt-1' }

/**
 * The flag is read asynchronously, so every switch has a window where it holds `null` — the read
 * has not settled and neither answer is known yet. Treating that as "off" is what made a flag-on
 * user watch the native screen mount and then be replaced by the page.
 */
describe('the hybrid shell switch decision', () => {
  it('waits while the flag is unresolved rather than answering native', () => {
    expect(shellSwitchDecision(null, ROUTE)).toEqual({ kind: 'pending' })
  })

  it('answers native with the flag off', () => {
    expect(shellSwitchDecision(false, ROUTE)).toEqual({ kind: 'native' })
  })

  it('answers the shell, carrying the route, with the flag on', () => {
    expect(shellSwitchDecision(true, ROUTE)).toEqual({ kind: 'shell', route: ROUTE })
  })

  it('answers native for a route the shell could never open, without waiting on the flag', () => {
    // No neutral frame is owed when the shell is not a possible outcome: a switch whose params
    // build no route the bridge would accept has one renderer, and holding it back would paint a
    // spinner over a screen that was always going to be the native one.
    expect(shellSwitchDecision(null, null)).toEqual({ kind: 'native' })
    expect(shellSwitchDecision(true, null)).toEqual({ kind: 'native' })
    expect(shellSwitchDecision(false, null)).toEqual({ kind: 'native' })
  })
})
