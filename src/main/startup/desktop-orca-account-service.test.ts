import { beforeEach, describe, expect, it, vi } from 'vitest'

const { calls, connector, signOutCurrentOrcaProfile, state } = vi.hoisted(() => {
  const calls: string[] = []
  const bots = { list: () => [] }
  return {
    calls,
    connector: {
      accountChanged: () => calls.push('connector-account-changed'),
      signOutStarted: () => calls.push('connector-sign-out-started'),
      signOutFinished: () => calls.push('connector-sign-out-finished')
    },
    bots,
    signOutCurrentOrcaProfile: vi.fn(async () => {
      calls.push('revoke-and-clear')
      return { status: 'signed-out' }
    }),
    state: {
      activeOrcaProfile: { profile: { id: 'profile-1' } },
      runtime: { bots },
      relayHost: {
        signOutStarted: () => calls.push('relay-sign-out-started'),
        accountChanged: () => calls.push('relay-account-changed')
      }
    }
  }
})

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))
vi.mock('./main-process-state', () => ({ mainProcessState: state }))
vi.mock('./cloud-startup/main-process-connector-startup', () => ({
  mainProcessConnectorCloud: () => connector
}))
vi.mock('../orca-profiles/cloud-auth/profile-cloud-service', () => ({
  signOutCurrentOrcaProfile,
  getCurrentOrcaProfileAuthStatus: () => ({
    activeProfileId: 'profile-1',
    cloud: { userId: 'user-a' }
  }),
  connectCurrentOrcaProfile: vi.fn(async () => ({ status: 'connected' }))
}))

import { createDesktopOrcaAccountService } from './desktop-orca-account-service'

describe('desktop Orca account service', () => {
  beforeEach(() => {
    calls.length = 0
  })

  it('fences the relay and connector before revoking, then finishes the connector', async () => {
    await createDesktopOrcaAccountService().signOut()

    expect(calls).toEqual([
      'relay-sign-out-started',
      'connector-sign-out-started',
      'revoke-and-clear',
      'connector-sign-out-finished'
    ])
  })

  it('retries the relay and tells the connector after a sign-in', async () => {
    await createDesktopOrcaAccountService().connect()

    expect(calls).toEqual(['relay-account-changed', 'connector-account-changed'])
  })
})
