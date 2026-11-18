import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setSecretStore } from '../../shared/secure-storage/secret-store'
import type { OrcaAccountSignInStatus } from '../../shared/orca-account-server-sign-in'
import type * as ProfileCloudClient from './cloud-auth/profile-cloud-client'
import type { OrcaCloudSessionExchangeResponse } from './cloud-session/profile-cloud-session-exchange'
import type { ServerSignInPollResult } from './orca-cloud-server-sign-in-requests'

const cloud = vi.hoisted(() => ({
  exchange: vi.fn(async (): Promise<unknown> => undefined),
  revoke: vi.fn(async () => {})
}))

vi.mock('./cloud-auth/profile-cloud-client', async (importOriginal) => ({
  ...(await importOriginal<typeof ProfileCloudClient>()),
  exchangeOrcaCloudAuthCode: cloud.exchange,
  revokeOrcaCloudSession: cloud.revoke
}))

import { OrcaAccountService } from './orca-account-service'
import { OrcaServerSignIn } from './orca-server-sign-in'

const ENV = {
  ORCA_CLOUD_API_URL: 'https://login.example.test',
  ORCA_CLOUD_CLIENT_ID: 'orca-desktop'
}
const REDIRECT = 'https://login.example.test/v1/server-sign-in/verify?request=req-1'

function exchangeFor(userId: string): OrcaCloudSessionExchangeResponse {
  return {
    accessToken: `access-${userId}`,
    refreshToken: `refresh-${userId}`,
    // Far future: these tests never refresh.
    expiresAt: 4_000_000_000_000,
    organizations: [],
    capabilities: { flags: {}, refreshedAt: 1 },
    cloud: { userId, cloudProfileId: `cp-${userId}`, email: `${userId}@example.test`, linkedAt: 1 }
  }
}

function gate<T>() {
  let open: (value: T) => void = () => {}
  const opened = new Promise<T>((resolve) => {
    open = resolve
  })
  return { opened, open }
}

let userDataPath = ''
const servers: OrcaServerSignIn[] = []

/** The desktop host's real account service, with the approve flow's cloud calls held by the test.
 * `watchSignOut: false` drops the sign-out hook, so only the epoch fences stand in the way. */
function desktopHost(poll: () => Promise<ServerSignInPollResult>, watchSignOut = true) {
  const account = new OrcaAccountService({
    openBrowser: async () => {},
    userDataPath: () => userDataPath
  })
  const server = new OrcaServerSignIn({
    account: watchSignOut
      ? account
      : {
          getAuthStatus: () => account.getAuthStatus(),
          signInWithCode: (...args) => account.signInWithCode(...args),
          selectOrg: (orgId) => account.selectOrg(orgId),
          signOut: () => account.signOut(),
          refreshAuth: () => account.refreshAuth()
        },
    probe: async () => true,
    env: ENV,
    machineLabel: () => 'devbox',
    platform: 'linux',
    startRequest: async () => ({
      requestId: 'req-1',
      claimToken: 'claim-secret',
      userCode: 'WDJB-MJHT',
      verificationUrl: 'https://login.example.test/v1/server-sign-in/verify?request=req-1',
      intervalSeconds: 5,
      expiresInSeconds: 600
    }),
    approval: { poll, now: () => 0, sleep: async (_ms, signal) => signal.throwIfAborted() }
  })
  servers.push(server)
  return { account, server }
}

async function settled(server: OrcaServerSignIn, start: OrcaAccountSignInStatus) {
  let status = start
  while (!['signedIn', 'failed', 'cancelled'].includes(status.phase)) {
    status = await server.waitSignIn('cli', start.flowId, status.revision)
  }
  return status
}

describe('approve-in-browser sign-in against a desktop sign-out', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-approve-sign-out-'))
    cloud.exchange.mockReset()
    cloud.exchange.mockResolvedValue(exchangeFor('user-a'))
    cloud.revoke.mockClear()
    setSecretStore({
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: (cipher) => cipher.toString(),
      describeProtectionGap: () => null,
      describeSealing: () => ({ kind: 'os-keychain' })
    })
  })

  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.dispose()
    }
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it.each([
    ['with the sign-out hook', true],
    ['through the epoch fence alone', false]
  ])(
    'stays signed out when an approval held in flight lands after the window signs out (%s)',
    async (_label, watchSignOut) => {
      const answer = gate<ServerSignInPollResult>()
      const poll = vi.fn(() => answer.opened)
      const { account, server } = desktopHost(poll, watchSignOut)
      const start = server.startSignIn('cli', 'sign-in', { approveInBrowser: true })
      await vi.waitFor(() => expect(poll).toHaveBeenCalled())

      // The desktop settings route calls the account service directly.
      await account.signOut()
      answer.open({ status: 'approved', code: 'one-time', redirectUri: REDIRECT })

      expect((await settled(server, start)).phase).not.toBe('signedIn')
      expect(cloud.exchange).not.toHaveBeenCalled()
      expect(account.getAuthStatus().state).not.toBe('connected')
    }
  )

  it('refuses at commit when the window signs out while the code is being exchanged', async () => {
    const exchanged = gate<OrcaCloudSessionExchangeResponse>()
    cloud.exchange.mockImplementation(() => exchanged.opened)
    const { account, server } = desktopHost(
      async () => ({ status: 'approved', code: 'one-time', redirectUri: REDIRECT }),
      false
    )
    const start = server.startSignIn('cli', 'sign-in', { approveInBrowser: true })
    await vi.waitFor(() => expect(cloud.exchange).toHaveBeenCalled())

    await account.signOut()
    exchanged.open(exchangeFor('user-a'))

    expect((await settled(server, start)).phase).not.toBe('signedIn')
    expect(account.getAuthStatus().state).not.toBe('connected')
    await vi.waitFor(() =>
      expect(cloud.revoke).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ refreshToken: 'refresh-user-a' })
      )
    )
  })
})
