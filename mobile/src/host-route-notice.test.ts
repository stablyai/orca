import { describe, expect, it } from 'vitest'
import {
  HOST_ROUTE_NOTICES,
  hostRouteNoticeMessage,
  hostRouteWithNotice,
  visibleHostRouteNotice
} from './host-route-notice'

describe('hostRouteNoticeMessage', () => {
  it('maps a known code to its banner text', () => {
    expect(hostRouteNoticeMessage('worktree-missing')).toBe(HOST_ROUTE_NOTICES['worktree-missing'])
  })

  it('renders nothing for absent or unrecognized codes', () => {
    expect(hostRouteNoticeMessage(undefined)).toBeNull()
    expect(hostRouteNoticeMessage('')).toBeNull()
    // A newer build's code must not leak the raw param into the UI.
    expect(hostRouteNoticeMessage('some-future-code')).toBeNull()
  })

  // A plain lookup returns Object.prototype members, which would hand the banner a function.
  it('renders nothing for prototype keys', () => {
    expect(hostRouteNoticeMessage('toString')).toBeNull()
    expect(hostRouteNoticeMessage('constructor')).toBeNull()
    expect(hostRouteNoticeMessage('__proto__')).toBeNull()
  })
})

describe('hostRouteWithNotice', () => {
  it('encodes the host id into the noticed route', () => {
    expect(hostRouteWithNotice('host/one', 'worktree-missing')).toBe(
      '/h/host%2Fone?notice=worktree-missing'
    )
  })
})

describe('visibleHostRouteNotice', () => {
  const message = HOST_ROUTE_NOTICES['worktree-missing']

  it('shows a notice the user has not dismissed', () => {
    expect(visibleHostRouteNotice(false, 'worktree-missing', null)).toBe(message)
  })

  it('stays silent once that code is dismissed', () => {
    expect(visibleHostRouteNotice(false, 'worktree-missing', 'worktree-missing')).toBeNull()
  })

  // Dismissal is keyed by code so a later, different bounce still gets to speak.
  it('still shows a different code after one was dismissed', () => {
    expect(visibleHostRouteNotice(false, 'worktree-missing', 'some-other-code')).toBe(message)
  })

  it('draws nothing in the embedded sidebar, which shares the route', () => {
    expect(visibleHostRouteNotice(true, 'worktree-missing', null)).toBeNull()
  })
})
