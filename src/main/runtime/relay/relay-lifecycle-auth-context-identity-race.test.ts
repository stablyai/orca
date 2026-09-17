import { describe, expect, it, vi } from 'vitest'
import { RELAY_HOST_CLOSE_REASON } from '../../../shared/relay-host-close-reason'

// Same taxonomy question 8972d744 answered for the session file, asked of the
// other null exit: readRelayAuthContext re-reads the profile after the refresh,
// and a profile switch landing in that window is not a sign-out.
const fakes = vi.hoisted(() => ({
  ensureActiveOrcaProfile: vi.fn(),
  readFreshOrcaCloudSession: vi.fn()
}))

vi.mock('../../orca-profiles/profile-index-store', () => ({
  ensureActiveOrcaProfile: fakes.ensureActiveOrcaProfile
}))
vi.mock('../../orca-profiles/profile-cloud-session-refresh', () => ({
  readFreshOrcaCloudSession: fakes.readFreshOrcaCloudSession
}))

import { readRelayAuthContext } from './relay-auth-context'
import { RelayAuthCoordinator } from './relay-auth-coordinator'

const authConfig = {} as never

function profile(id: string, cloud: object | null) {
  return { profile: { id, ...(cloud ? { cloud } : {}) } }
}

const signedIn = { userId: 'u1', cloudProfileId: 'cp1', activeOrgId: 'org-1' }

function foundSession() {
  return {
    status: 'found',
    session: { accessToken: 'access-1', capabilities: { flags: { 'relay.use': true } } }
  }
}

describe('readRelayAuthContext profile-switch race', () => {
  it('refuses to call a mid-read profile switch a sign-out', async () => {
    // ensureActiveOrcaProfile is called twice — once before the refresh and once
    // after, because refresh and org selection can rewrite cloud linkage. A
    // switch between them means "re-read", not "the cloud session is gone".
    fakes.ensureActiveOrcaProfile
      .mockReturnValueOnce(profile('profile-1', signedIn))
      .mockReturnValueOnce(profile('profile-2', signedIn))
    fakes.readFreshOrcaCloudSession.mockResolvedValue(foundSession())

    await expect(readRelayAuthContext(authConfig, '/tmp/x')).rejects.toThrow(
      'orca_profile_switched_during_read'
    )
  })

  it('classifies the switch as auth_unavailable, never signed_out', async () => {
    fakes.ensureActiveOrcaProfile
      .mockReturnValueOnce(profile('profile-1', signedIn))
      .mockReturnValueOnce(profile('profile-2', signedIn))
    fakes.readFreshOrcaCloudSession.mockResolvedValue(foundSession())
    const broker = { closeNow: vi.fn() }
    const coordinator = new RelayAuthCoordinator({
      readContext: () => readRelayAuthContext(authConfig, '/tmp/x'),
      openBroker: async () => broker,
      onStatus: vi.fn()
    })
    coordinator.reconcile()

    const result = await coordinator.waitForLiveBrokerResult(0)
    expect(result).toEqual({ broker: null, offlineReason: 'auth_unavailable' })
    // SIGNED_OUT is terminal on the wire — the phone latches it and arms no retry.
    expect(broker.closeNow).not.toHaveBeenCalledWith(RELAY_HOST_CLOSE_REASON.SIGNED_OUT)
  })

  it('still reports a profile that genuinely has no cloud linkage as gone', async () => {
    fakes.ensureActiveOrcaProfile
      .mockReturnValueOnce(profile('profile-1', signedIn))
      .mockReturnValueOnce(profile('profile-1', null))
    fakes.readFreshOrcaCloudSession.mockResolvedValue(foundSession())

    await expect(readRelayAuthContext(authConfig, '/tmp/x')).resolves.toBeNull()
  })

  it('returns the post-refresh identity when the profile held still', async () => {
    fakes.ensureActiveOrcaProfile
      .mockReturnValueOnce(profile('profile-1', signedIn))
      .mockReturnValueOnce(profile('profile-1', { ...signedIn, activeOrgId: 'org-2' }))
    fakes.readFreshOrcaCloudSession.mockResolvedValue(foundSession())

    await expect(readRelayAuthContext(authConfig, '/tmp/x')).resolves.toEqual({
      identity: { userId: 'u1', profileId: 'cp1', organizationId: 'org-2' },
      accessToken: 'access-1',
      relayEntitled: true
    })
  })
})
