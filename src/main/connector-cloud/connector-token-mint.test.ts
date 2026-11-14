import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaCloudAuthConfig } from '../orca-profiles/cloud-auth/profile-cloud-auth-config'
import { desktopConnectorTokenMint } from './connector-token-mint'

const profile = vi.hoisted(() => {
  const state: { cloud?: { userId: string } } = { cloud: { userId: 'ada' } }
  return state
})
const runFresh = vi.hoisted(() => vi.fn())

vi.mock('../orca-profiles/profile-index-store', () => ({
  ensureActiveOrcaProfile: () => ({ profile: { id: 'p1', cloud: profile.cloud } })
}))
vi.mock('../orca-profiles/cloud-session/profile-cloud-session-refresh', () => ({
  runWithFreshOrcaCloudSession: runFresh
}))
vi.mock('../runtime/hosts/platform-probe/host-descriptor', () => ({
  loadOrCreateHostInstallationId: async () => '6b1f2c1e-0d7a-4a57-9b38-6f1c2e3d4a5b'
}))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mint reads only this endpoint.
const authConfig = {
  connectorTokenEndpoint: 'https://login.test/v1/desktop/auth/connector-token'
} as OrcaCloudAuthConfig

let fetchImpl: ReturnType<typeof vi.fn<typeof globalThis.fetch>>

beforeEach(() => {
  profile.cloud = { userId: 'ada' }
  runFresh.mockReset()
  runFresh.mockImplementation(async (_config, _active, _path, operation) => ({
    status: 'ok',
    value: await operation({ accessToken: 'access-1' })
  }))
  fetchImpl = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(JSON.stringify({ connectorToken: 'ct-1', expiresAt: 1_800_000_300_000 }), {
        status: 200
      })
  )
})

describe('desktopConnectorTokenMint', () => {
  it('mints nothing for an account that is no longer the signed-in one', async () => {
    profile.cloud = { userId: 'grace' }
    const minted = await desktopConnectorTokenMint(authConfig, '/data', 'ada', fetchImpl)()
    expect(minted).toMatchObject({ ok: false, status: 401, error: 'signed_out' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
