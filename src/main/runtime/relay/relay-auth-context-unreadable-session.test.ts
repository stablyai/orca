import { describe, expect, it, vi } from 'vitest'
import { RELAY_HOST_CLOSE_REASON } from '../../../shared/relay-host-close-reason'

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

const profile = {
  profile: {
    id: 'profile-1',
    cloud: { userId: 'u1', cloudProfileId: 'cp1', activeOrgId: 'org-1' }
  }
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the session read is mocked, so readRelayAuthContext never dereferences the config on this path.
const authConfig = {} as never

describe('readRelayAuthContext session-read taxonomy', () => {
  it('still reports a genuinely absent session as gone', async () => {
    fakes.ensureActiveOrcaProfile.mockReturnValue(profile)
    fakes.readFreshOrcaCloudSession.mockResolvedValue({ status: 'reconnect-required' })

    await expect(readRelayAuthContext(authConfig, '/tmp/x')).resolves.toBeNull()
  })

  it('classifies an unreadable session as auth_unavailable, never signed_out', async () => {
    // EACCES/EBUSY/EMFILE on the session file means "present, could not read it", which the
    // refresh layer raises. Reporting it as signed-out tells every paired phone to sign in on
    // the desktop for a failure a retry would have cleared.
    fakes.ensureActiveOrcaProfile.mockReturnValue(profile)
    fakes.readFreshOrcaCloudSession.mockRejectedValue(new Error('orca_cloud_session_unreadable'))
    const broker = { closeNow: vi.fn() }
    const coordinator = new RelayAuthCoordinator({
      readContext: () => readRelayAuthContext(authConfig, '/tmp/x'),
      openBroker: async () => broker,
      onStatus: vi.fn()
    })
    coordinator.reconcile()

    // Budget 0: the classification is published before any retry is waited on, and the
    // default budget would park this test through the whole backoff ladder.
    const result = await coordinator.waitForLiveBrokerResult(0)
    expect(result).toEqual({ broker: null, offlineReason: 'auth_unavailable' })
    expect(result.broker).toBeNull()
    // The wire close reason is what the phone latches on; it must not be spent here.
    expect(broker.closeNow).not.toHaveBeenCalledWith(RELAY_HOST_CLOSE_REASON.SIGNED_OUT)
    // Why stop(): a transient read arms a retry, and an escaped timer fires inside whatever
    // test runs next in this worker.
    coordinator.stop()
  })
})
