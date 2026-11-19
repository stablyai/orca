import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaCloudAuthConfig } from './profile-cloud-auth-config'

const { calls, client, owner } = vi.hoisted(() => {
  const calls: string[] = []
  return {
    calls,
    client: {
      exchangeOrcaCloudAuthCode: vi.fn(),
      revokeOrcaCloudSession: vi.fn(async (_config: unknown, session: { refreshToken: string }) => {
        calls.push(`revoke:${session.refreshToken}`)
      })
    },
    owner: {
      readCloudSession: vi.fn(),
      sessionFromExchange: (exchange: { refreshToken: string }) => exchange,
      signInCloudSession: vi.fn(
        (_profileId: string, _path: string, exchange: { refreshToken: string }) => {
          calls.push(`save:${exchange.refreshToken}`)
        }
      )
    }
  }
})

vi.mock('./profile-cloud-client', () => client)
vi.mock('../cloud-session/profile-cloud-session-owner', () => owner)
vi.mock('./profile-cloud-index', () => ({
  linkOrcaProfileToCloud: () => ({ activeProfileId: 'profile-1', profiles: [] })
}))
vi.mock('../profile-index-store', () => ({
  ensureActiveOrcaProfile: () => ({ profile: { id: 'profile-1' } }),
  loadOrCreateProfileIndex: () => ({ profiles: [{ id: 'profile-1' }] })
}))
vi.mock('./profile-cloud-service', () => ({
  getCurrentOrcaProfileAuthStatus: () => ({ activeProfileId: 'profile-1' })
}))

import { signInCurrentOrcaProfileWithCode } from './profile-cloud-code-sign-in'

const config = {
  sessionEndpoint: 'https://login.example.test/v1/desktop/auth/session'
} satisfies Partial<OrcaCloudAuthConfig>
const code = {
  code: 'one-time',
  codeVerifier: 'verifier',
  nonce: 'nonce',
  redirectUri: 'https://login.example.test/v1/desktop/auth/server-sign-in/code',
  state: 'state'
}

function signIn() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the client that reads the config is mocked.
  return signInCurrentOrcaProfileWithCode('/user-data', config as OrcaCloudAuthConfig, code)
}

describe('signInCurrentOrcaProfileWithCode', () => {
  beforeEach(() => {
    calls.length = 0
    client.exchangeOrcaCloudAuthCode.mockReset()
    owner.readCloudSession.mockReset()
  })

  it('revokes the account it replaces only after the new session is saved', async () => {
    client.exchangeOrcaCloudAuthCode.mockResolvedValue({ refreshToken: 'new', cloud: {} })
    owner.readCloudSession.mockReturnValue({
      status: 'found',
      session: { refreshToken: 'old' }
    })

    await expect(signIn()).resolves.toMatchObject({ status: 'connected' })

    expect(calls).toEqual(['save:new', 'revoke:old'])
  })

  it('keeps the signed-in account when the code is refused', async () => {
    client.exchangeOrcaCloudAuthCode.mockRejectedValue(new Error('orca_cloud_request_failed_400'))

    await expect(signIn()).resolves.toMatchObject({
      status: 'failed',
      error: 'orca_cloud_request_failed_400'
    })

    expect(calls).toEqual([])
  })
})
