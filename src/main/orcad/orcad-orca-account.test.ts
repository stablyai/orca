import { afterEach, describe, expect, it } from 'vitest'
import { flushUnsavedCloudSessions } from '../orca-profiles/cloud-session/profile-cloud-session-owner'
import { getOrcaServerSignIn, installOrcaServerSignIn } from '../orca-profiles/orca-server-sign-in'
import type { BackendServiceCleanup } from '../backend/service-composition'
import { installOrcadOrcaAccount } from './orcad-orca-account'

afterEach(() => installOrcaServerSignIn(null))

describe('installOrcadOrcaAccount', () => {
  it('installs the account sign-in, flushes unsaved rotations on SIGTERM, and uninstalls on cleanup', async () => {
    const cleanups: BackendServiceCleanup[] = []

    const served: string[] = []
    installOrcadOrcaAccount(
      {
        bots: { list: () => [] },
        serveOrcaProfile: (id) => served.push(id),
        getConnectorCloud: () => null
      },
      { accountChanged: () => {}, signOutStarted: () => {} },
      (cleanup) => cleanups.push(cleanup),
      'profile-1'
    )

    expect(served).toEqual(['profile-1'])

    expect(getOrcaServerSignIn()).not.toBeNull()
    expect(cleanups).toContain(flushUnsavedCloudSessions)
    for (const cleanup of cleanups) {
      await cleanup({ failed: false })
    }
    expect(getOrcaServerSignIn()).toBeNull()
  })

  it("stops this server's relay and connector when it signs out, and lets them resume after", async () => {
    const calls: string[] = []
    const connector = {
      accountChanged: () => calls.push('accountChanged'),
      signOutStarted: () => calls.push('signOutStarted'),
      signOutFinished: () => calls.push('signOutFinished')
    }
    installOrcadOrcaAccount(
      {
        bots: { list: () => [] },
        serveOrcaProfile: () => {},
        getConnectorCloud: () => connector
      },
      {
        accountChanged: () => calls.push('relay.accountChanged'),
        signOutStarted: () => calls.push('relay.signOutStarted')
      },
      () => {},
      null
    )

    await getOrcaServerSignIn()!.signOut()

    expect(calls).toEqual(['relay.signOutStarted', 'signOutStarted', 'signOutFinished'])
  })
})
