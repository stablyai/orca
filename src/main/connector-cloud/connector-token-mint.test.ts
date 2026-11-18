import { createPublicKey, verify } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { OrcaCloudAuthConfig } from '../orca-profiles/cloud-auth/profile-cloud-auth-config'
import type { OrcaCloudSession } from '../orca-profiles/cloud-session/profile-cloud-session-store'
import type { ActiveOrcaProfileState } from '../orca-profiles/profile-index-store'
import { OrcaCloudRequestError } from '../orca-profiles/cloud-auth/profile-cloud-client'
import { runWithFreshOrcaCloudSession } from '../orca-profiles/cloud-session/profile-cloud-session-refresh'
import { connectorStop } from './connector-cloud-request'
import { desktopConnectorTokenMint } from './connector-token-mint'

const profile = vi.hoisted(() => {
  const state: { cloud?: { userId: string; cloudProfileId: string } } = {}
  return state
})
// The stored sign-in; the real session module reads, rotates and clears it.
const store = vi.hoisted(() => {
  const state: { session: OrcaCloudSession | null; signedOut: number } = {
    session: null,
    signedOut: 0
  }
  return state
})

vi.mock('../orca-profiles/profile-index-store', () => ({
  ensureActiveOrcaProfile: () => ({ profile: { id: 'p1', cloud: profile.cloud } })
}))
vi.mock('../orca-profiles/cloud-session/profile-cloud-session-owner', () => ({
  readCloudSession: () =>
    store.session ? { status: 'found', session: store.session } : { status: 'missing' },
  takeCloudSessionTicket: () => 1,
  commitCloudSessionRotation: (
    _profileId: string,
    _userDataPath: string,
    _ticket: number,
    _previous: OrcaCloudSession,
    next: OrcaCloudSession
  ) => {
    store.session = {
      accessToken: next.accessToken,
      refreshToken: next.refreshToken,
      expiresAt: next.expiresAt,
      capabilities: next.capabilities
    }
    return store.session
  },
  signOutRevokedCloudSession: (
    _profileId: string,
    _userDataPath: string,
    failed: OrcaCloudSession
  ) => {
    if (store.session?.refreshToken !== failed.refreshToken) {
      return false
    }
    store.session = null
    store.signedOut += 1
    return true
  }
}))
vi.mock('../runtime/hosts/platform-probe/host-descriptor', () => ({
  loadOrCreateHostInstallationId: async () => '6b1f2c1e-0d7a-4a57-9b38-6f1c2e3d4a5b'
}))

const AUTH = 'https://login.test'
const authConfig: OrcaCloudAuthConfig = {
  apiBaseUrl: AUTH,
  authorizeEndpoint: `${AUTH}/authorize`,
  sessionEndpoint: `${AUTH}/session`,
  refreshEndpoint: `${AUTH}/refresh`,
  capabilitiesEndpoint: `${AUTH}/capabilities`,
  profileEndpoint: `${AUTH}/profile`,
  orgEndpoint: `${AUTH}/org`,
  logoutEndpoint: `${AUTH}/logout`,
  relayTokenEndpoint: `${AUTH}/relay-token`,
  connectorTokenEndpoint: `${AUTH}/v1/desktop/auth/connector-token`,
  relayDirectorUrl: AUTH,
  clientId: 'client-1',
  scope: 'openid'
}

const MACHINE_ID = '6b1f2c1e-0d7a-4a57-9b38-6f1c2e3d4a5b'
const HOUR_MS = 3_600_000

let fetchImpl: ReturnType<typeof vi.fn<typeof globalThis.fetch>>
let userData: string
let serverFlags: Record<string, boolean>
// Calls to the auth service's /refresh, each one a refresh-token rotation.
let rotations: number

function signIn(): void {
  store.session = {
    accessToken: 'access-0',
    refreshToken: 'refresh-0',
    expiresAt: Date.now() + HOUR_MS,
    capabilities: { flags: serverFlags, refreshedAt: 1 }
  }
}

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

function unauthorized(): Response {
  return answer(401, { error: 'invalid_token' })
}

function bearer(call: number): string | null {
  return new Headers(fetchImpl.mock.calls[call]?.[1]?.headers).get('authorization')
}

function sentBody(call: number): unknown {
  return JSON.parse(String(fetchImpl.mock.calls[call]?.[1]?.body))
}

const SentProof = z.object({
  publicKey: z.string(),
  signedAt: z.number(),
  nonce: z.string(),
  signature: z.string(),
  reset: z.boolean().optional()
})
type SentProof = z.infer<typeof SentProof>
const SentBody = z.object({ machineId: z.literal(MACHINE_ID), hostKey: SentProof })

function sentProof(call: number): SentProof {
  return SentBody.parse(sentBody(call)).hostKey
}

// The wire format the Orca Cloud connector service verifies, spelled out independently.
function verifiesAs(proof: SentProof, purpose: 'mint' | 'reset', userId = 'ada'): boolean {
  const message = [
    'orca-connector-host-proof/v1',
    userId,
    MACHINE_ID,
    proof.publicKey,
    String(proof.signedAt),
    proof.nonce,
    purpose
  ].join('\n')
  const key = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: proof.publicKey },
    format: 'jwk'
  })
  return verify(null, Buffer.from(message), key, Buffer.from(proof.signature, 'base64url'))
}

function refusal(body: { error: string; serverTime?: number }): Response {
  return new Response(JSON.stringify(body), { status: 403 })
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ['Date'] })
  userData = mkdtempSync(join(tmpdir(), 'orca-connector-mint-'))
  profile.cloud = { userId: 'ada', cloudProfileId: 'cloud-ada' }
  serverFlags = { 'connector.hostKey': true }
  store.signedOut = 0
  signIn()
  rotations = 0
  // The auth service's /refresh: every rotation is accepted.
  vi.stubGlobal('fetch', async () => {
    rotations++
    return answer(200, {
      accessToken: `access-${rotations}`,
      refreshToken: `refresh-${rotations}`,
      expiresAt: Date.now() + HOUR_MS,
      cloud: { cloudProfileId: 'cloud-ada', userId: 'ada', email: 'ada@example.com' },
      capabilities: { flags: serverFlags, refreshedAt: 1 }
    })
  })
  fetchImpl = vi.fn<typeof globalThis.fetch>(async () =>
    answer(200, { connectorToken: 'ct-1', expiresAt: 1_800_000_300_000 })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('desktopConnectorTokenMint', () => {
  it('mints nothing for an account that is no longer the signed-in one', async () => {
    profile.cloud = { userId: 'grace', cloudProfileId: 'cloud-grace' }
    const minted = await desktopConnectorTokenMint(authConfig, userData, 'ada', fetchImpl)()
    expect(minted).toMatchObject({ ok: false, status: 401, error: 'signed_out' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refreshes the session once for an unexplained 401 and mints with the fresh one', async () => {
    fetchImpl.mockResolvedValueOnce(unauthorized())
    const minted = await desktopConnectorTokenMint(authConfig, userData, 'ada', fetchImpl)()
    expect(minted).toMatchObject({ ok: true, value: { connectorToken: 'ct-1' } })
    expect(rotations).toBe(1)
    expect(bearer(1)).toBe('Bearer access-1')
  })

  it('does not sign out when the mint still answers 401 after the refresh', async () => {
    fetchImpl.mockImplementation(async () => unauthorized())
    const refused = await desktopConnectorTokenMint(authConfig, userData, 'ada', fetchImpl)()
    expect(store.signedOut).toBe(0)
    expect(store.session).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1' })
    expect(rotations).toBe(1)
    expect(refused).toEqual({
      ok: false,
      status: 401,
      error: 'invalid_token',
      retryAfterMs: null,
      sessionRefused: true
    })
  })

  it("shares the app's refresh budget, so repeated 401s rotate at most once per 5 minutes", async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: refresh reads only profile.id and profile.cloud.
    const active = { profile: { id: 'p1', cloud: profile.cloud } } as ActiveOrcaProfileState
    let appCalls = 0
    const app = await runWithFreshOrcaCloudSession(authConfig, active, userData, async () => {
      if (appCalls++ === 0) {
        throw new OrcaCloudRequestError(401, 'invalid_token')
      }
      return 'ok'
    })
    expect(app).toEqual({ status: 'ok', value: 'ok' })
    expect(rotations).toBe(1)

    fetchImpl.mockImplementation(async () => unauthorized())
    const mint = desktopConnectorTokenMint(authConfig, userData, 'ada', fetchImpl)
    for (let attempt = 0; attempt < 4; attempt++) {
      const skipped = await mint()
      expect(skipped).toMatchObject({ status: 401 })
      expect(skipped).not.toHaveProperty('sessionRefused')
      vi.advanceTimersByTime(60_000)
    }
    expect(rotations).toBe(1)
    vi.advanceTimersByTime(60_000)
    expect(await mint()).toMatchObject({ status: 401, sessionRefused: true })
    expect(rotations).toBe(2)
    expect(store.signedOut).toBe(0)
  })

  it('does not ask for sign-in while the auth service is down', async () => {
    let refreshCalls = 0
    vi.stubGlobal('fetch', async () => {
      refreshCalls++
      return answer(503, { error: 'unavailable' })
    })
    fetchImpl.mockImplementation(async () => unauthorized())
    const mint = desktopConnectorTokenMint(authConfig, userData, 'ada', fetchImpl)
    expect(await mint()).toMatchObject({ ok: false, status: null })
    expect(refreshCalls).toBe(2)

    vi.advanceTimersByTime(30_000)
    const retried = await mint()
    expect(retried).toMatchObject({ ok: false, status: 401 })
    expect(retried).not.toHaveProperty('sessionRefused')
    expect(store.signedOut).toBe(0)
  })

  it('never refreshes the session for a 403, whatever its code', async () => {
    const mint = desktopConnectorTokenMint(authConfig, userData, 'ada', fetchImpl)
    for (const error of [
      'forbidden',
      'host_key_limit',
      'host_proof_invalid',
      'host_key_mismatch',
      'recent_sign_in_required',
      'machine_mismatch',
      'desktop_session_required'
    ]) {
      fetchImpl.mockResolvedValueOnce(refusal({ error }))
      expect(await mint()).toMatchObject({ ok: false, status: 403, error })
    }
    expect(rotations).toBe(0)
    expect(store.session?.refreshToken).toBe('refresh-0')
  })

  it('keeps Retry-After on a paced refusal, capped at 10 minutes', async () => {
    fetchImpl.mockResolvedValueOnce(
      new Response(null, { status: 429, headers: { 'retry-after': '30' } })
    )
    const paced = await desktopConnectorTokenMint(authConfig, userData, 'ada', fetchImpl)()
    expect(paced).toMatchObject({ ok: false, status: 429, retryAfterMs: 30_000 })

    fetchImpl.mockResolvedValueOnce(
      new Response(null, { status: 429, headers: { 'retry-after': '99999999999' } })
    )
    const capped = await desktopConnectorTokenMint(authConfig, userData, 'ada', fetchImpl)()
    expect(capped).toMatchObject({ retryAfterMs: 10 * 60_000 })
  })

  it('returns a machine-cap refusal with its wait and words, without refreshing the session', async () => {
    fetchImpl.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'host_key_limit',
          message: 'This account has too many machines enrolled.',
          retryAfterSeconds: 120
        }),
        { status: 403, headers: { 'retry-after': '120' } }
      )
    )
    const refused = await desktopConnectorTokenMint(authConfig, userData, 'ada', fetchImpl)()
    expect(refused).toEqual({
      ok: false,
      status: 403,
      error: 'host_key_limit',
      retryAfterMs: 120_000,
      message: 'This account has too many machines enrolled.'
    })
    expect(refused.ok ? null : connectorStop(refused)).toBeNull()
    expect(rotations).toBe(0)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("proves the install's own host key on every mint, kept beside the install id", async () => {
    await desktopConnectorTokenMint(authConfig, userData, 'ada', fetchImpl)()
    await desktopConnectorTokenMint(authConfig, userData, 'ada', fetchImpl)()
    const [first, second] = [sentProof(0), sentProof(1)]
    expect(verifiesAs(first, 'mint')).toBe(true)
    expect(verifiesAs(second, 'mint')).toBe(true)
    expect(second.publicKey).toBe(first.publicKey)
    expect(second.nonce).not.toBe(first.nonce)
    expect(first.reset).toBeUndefined()
    if (process.platform !== 'win32') {
      expect(statSync(join(userData, 'connector-host-key.json')).mode & 0o777).toBe(0o600)
    }
  })

  it('stops on a refused key, then asks to replace it until the cloud accepts', async () => {
    fetchImpl.mockResolvedValueOnce(refusal({ error: 'host_key_mismatch' }))
    const refused = await desktopConnectorTokenMint(authConfig, userData, 'ada', fetchImpl)()
    expect(refused).toMatchObject({ ok: false, status: 403, error: 'host_key_mismatch' })
    expect(rotations).toBe(0)

    fetchImpl.mockResolvedValueOnce(refusal({ error: 'recent_sign_in_required' }))
    await desktopConnectorTokenMint(authConfig, userData, 'ada', fetchImpl)()
    const notRecent = sentProof(1)
    expect(notRecent.reset).toBe(true)
    expect(verifiesAs(notRecent, 'reset')).toBe(true)

    const accepted = await desktopConnectorTokenMint(authConfig, userData, 'ada', fetchImpl)()
    expect(accepted).toMatchObject({ ok: true, value: { connectorToken: 'ct-1' } })
    expect(sentProof(2).reset).toBe(true)
    await desktopConnectorTokenMint(authConfig, userData, 'ada', fetchImpl)()
    expect(sentProof(3).reset).toBeUndefined()
  })

  it('re-signs once on the server clock after a stale-proof refusal', async () => {
    const serverTime = 1_900_000_000_000
    fetchImpl.mockResolvedValueOnce(refusal({ error: 'host_proof_stale', serverTime }))
    const minted = await desktopConnectorTokenMint(authConfig, userData, 'ada', fetchImpl)()
    expect(minted).toMatchObject({ ok: true, value: { connectorToken: 'ct-1' } })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const retried = sentProof(1)
    expect(verifiesAs(retried, 'mint')).toBe(true)
    expect(Math.abs(retried.signedAt - serverTime)).toBeLessThan(60_000)
  })

  it('mints exactly as before against a server that does not advertise the proof', async () => {
    serverFlags = { 'relay.use': true }
    signIn()
    const minted = await desktopConnectorTokenMint(authConfig, userData, 'ada', fetchImpl)()
    expect(minted).toMatchObject({ ok: true, value: { connectorToken: 'ct-1' } })
    expect(sentBody(0)).toEqual({ machineId: MACHINE_ID })
    expect(existsSync(join(userData, 'connector-host-key.json'))).toBe(false)
  })

  it('proves once when the server requires it before the stored capabilities say so', async () => {
    serverFlags = {}
    signIn()
    fetchImpl.mockResolvedValueOnce(refusal({ error: 'host_proof_required' }))
    const minted = await desktopConnectorTokenMint(authConfig, userData, 'ada', fetchImpl)()
    expect(minted).toMatchObject({ ok: true, value: { connectorToken: 'ct-1' } })
    expect(sentBody(0)).toEqual({ machineId: MACHINE_ID })
    expect(verifiesAs(sentProof(1), 'mint')).toBe(true)
  })

  it('stops, rather than retrying forever, when the required proof cannot be made', async () => {
    // A key path that cannot be read as a file.
    mkdirSync(join(userData, 'connector-host-key.json'))
    fetchImpl.mockResolvedValue(refusal({ error: 'host_proof_required' }))
    const refused = await desktopConnectorTokenMint(authConfig, userData, 'ada', fetchImpl)()
    expect(refused).toMatchObject({ ok: false, status: 403, error: 'host_proof_required' })
    expect(refused.ok ? null : connectorStop(refused)).toBe('host_proof_required')
  })

  it("keeps one account's pending reset from being cleared by another account", async () => {
    fetchImpl.mockResolvedValueOnce(refusal({ error: 'host_key_mismatch' }))
    await desktopConnectorTokenMint(authConfig, userData, 'ada', fetchImpl)()

    profile.cloud = { userId: 'grace', cloudProfileId: 'cloud-grace' }
    await desktopConnectorTokenMint(authConfig, userData, 'grace', fetchImpl)()
    const grace = sentProof(1)
    expect(grace.reset).toBeUndefined()
    expect(verifiesAs(grace, 'mint', 'grace')).toBe(true)

    profile.cloud = { userId: 'ada', cloudProfileId: 'cloud-ada' }
    await desktopConnectorTokenMint(authConfig, userData, 'ada', fetchImpl)()
    expect(sentProof(2).reset).toBe(true)
    expect(readdirSync(userData).filter((name) => name.includes('reset-pending'))).toHaveLength(0)
  })
})
