import type { Session } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { serverProfileId } = vi.hoisted(() => {
  const named: { current: string | null } = { current: null }
  return { serverProfileId: named }
})

vi.mock('./browser-session-registry', () => ({
  browserSessionRegistry: {
    profileIdForSession: () => null,
    // Every id is a local profile here: a server-named id that matches one must still be refused.
    getProfile: (id: string) => ({ id })
  }
}))
vi.mock('../../routing/local-host-partitions/local-ssh-browser-partitions', () => ({
  localSshBrowserProfileIdForSession: () => null
}))
vi.mock('../../routing/sessions/browser-route-session-runtime', () => ({
  browserRouteSessionRegistry: { getBrowserProfileIdForSession: () => serverProfileId.current }
}))

import { localBrowserProfileIdForSession } from './browser-session-local-profile'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked lookups never read the session.
const thisDevicePageSession = {} as Session

describe('localBrowserProfileIdForSession', () => {
  beforeEach(() => {
    serverProfileId.current = null
  })

  it("gives a This-device page this desktop's default profile for the server's default", () => {
    serverProfileId.current = 'default'
    expect(localBrowserProfileIdForSession(thisDevicePageSession)).toBe('default')
  })

  it('gives a This-device page no local profile for a server profile whose id matches one', () => {
    serverProfileId.current = 'work'
    expect(localBrowserProfileIdForSession(thisDevicePageSession)).toBeNull()
  })
})
