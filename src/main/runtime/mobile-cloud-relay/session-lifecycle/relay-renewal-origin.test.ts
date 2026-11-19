import { describe, expect, it } from 'vitest'
import type { OrcaCloudAuthConfig } from '../../../orca-profiles/cloud-auth/profile-cloud-auth-config'
import { OrcaCloudRequestError } from '../../../orca-profiles/cloud-auth/profile-cloud-client'
import type { E2EEKeypair } from '../../rpc/server/pairing/e2ee-keypair'
import type { RelayAccessTokenRefresh } from './relay-session-broker-contract'
import {
  RelayRenewalOrigin,
  relayAuthConfigAt,
  renewRelayAuthorization,
  type RelayRenewal
} from './relay-renewal-origin'

const AUTH_BASE = 'https://auth.example.test'
const FRONT_DOOR = 'https://front-door.example.test'

const authConfig = {
  apiBaseUrl: AUTH_BASE,
  authorizeEndpoint: `${AUTH_BASE}/v1/desktop/auth/authorize`,
  sessionEndpoint: `${AUTH_BASE}/v1/desktop/auth/session`,
  refreshEndpoint: `${AUTH_BASE}/v1/desktop/auth/refresh`,
  capabilitiesEndpoint: `${AUTH_BASE}/v1/desktop/auth/capabilities`,
  profileEndpoint: `${AUTH_BASE}/v1/desktop/auth/profile`,
  orgEndpoint: `${AUTH_BASE}/v1/desktop/auth/org`,
  logoutEndpoint: `${AUTH_BASE}/v1/desktop/auth/logout`,
  relayTokenEndpoint: `${AUTH_BASE}/v1/desktop/auth/relay-token`,
  connectorTokenEndpoint: `${AUTH_BASE}/v1/desktop/auth/connector-token`,
  relayDirectorUrl: 'https://director.example.test',
  clientId: 'client',
  scope: 'openid'
} satisfies OrcaCloudAuthConfig

const keypair: E2EEKeypair = {
  publicKey: new Uint8Array(32),
  secretKey: new Uint8Array(32),
  publicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
}

type Outcome = 'ok' | 'network' | 503 | 401 | 403

// One fake auth service per origin: the session refresh (readContext) and the relay-token POST.
function fakeAuth(plan: { refresh?: Outcome[]; relayToken?: Outcome[] }) {
  const refreshes: (string | undefined)[] = []
  const relayTokenUrls: string[] = []
  const refreshPlan = [...(plan.refresh ?? [])]
  const relayTokenPlan = [...(plan.relayToken ?? [])]
  const refreshAccessToken = async (authOrigin?: string): Promise<RelayAccessTokenRefresh> => {
    refreshes.push(authOrigin)
    const outcome = refreshPlan.shift() ?? 'ok'
    if (outcome === 'network') {
      throw new TypeError('fetch failed')
    }
    if (outcome !== 'ok') {
      throw new OrcaCloudRequestError(outcome)
    }
    return { accessToken: 'access-token' }
  }
  const fetch: typeof globalThis.fetch = async (url) => {
    relayTokenUrls.push(String(url))
    const outcome = relayTokenPlan.shift() ?? 'ok'
    if (outcome === 'network') {
      throw new TypeError('fetch failed')
    }
    if (outcome !== 'ok') {
      return new Response('{}', { status: outcome })
    }
    return new Response(JSON.stringify({ relayToken: 'relay-jwt', expiresAt: 1_900_000_000 }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }
  return { refreshAccessToken, fetch, refreshes, relayTokenUrls }
}

// The broker's renewal loop: one attempt per retry tick, origin chosen by RelayRenewalOrigin.
async function renewUntilSuccess(
  auth: ReturnType<typeof fakeAuth>,
  authOrigin: string | undefined,
  maxAttempts = 6
): Promise<{ attempts: number; renewal: RelayRenewal | null }> {
  const origin = new RelayRenewalOrigin()
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const renewal = await renewRelayAuthorization(
        {
          authConfig,
          refreshAccessToken: auth.refreshAccessToken,
          keypair,
          fetch: auth.fetch,
          isCurrent: () => true
        },
        origin.next(authOrigin)
      )
      origin.succeeded()
      return { attempts: attempt, renewal }
    } catch (error) {
      origin.failed(error, authOrigin)
    }
  }
  return { attempts: maxAttempts, renewal: null }
}

const PRIMARY_TOKEN_URL = `${AUTH_BASE}/v1/desktop/auth/relay-token`
const DOOR_TOKEN_URL = `${FRONT_DOOR}/v1/desktop/auth/relay-token`

describe('relayAuthConfigAt', () => {
  it('moves only the refresh and relay-token endpoints to the auth origin', () => {
    expect(relayAuthConfigAt(authConfig, FRONT_DOOR)).toEqual({
      ...authConfig,
      refreshEndpoint: `${FRONT_DOOR}/v1/desktop/auth/refresh`,
      relayTokenEndpoint: DOOR_TOKEN_URL
    })
  })
})

describe('relay token renewal with an authOrigin', () => {
  it('renews through the authOrigin when the session refresh on the auth base gets no answer', async () => {
    const auth = fakeAuth({ refresh: ['network'] })
    const result = await renewUntilSuccess(auth, FRONT_DOOR)
    expect(result.attempts).toBe(2)
    expect(result.renewal).toMatchObject({ kind: 'renewed' })
    expect(auth.refreshes).toEqual([undefined, FRONT_DOOR])
    expect(auth.relayTokenUrls).toEqual([DOOR_TOKEN_URL])
  })

  it('renews through the authOrigin when the relay-token POST on the auth base fails 5xx or times out', async () => {
    for (const failure of [503, 'network'] as const) {
      const auth = fakeAuth({ relayToken: [failure] })
      const result = await renewUntilSuccess(auth, FRONT_DOOR)
      expect(result.attempts).toBe(2)
      expect(auth.refreshes).toEqual([undefined, FRONT_DOOR])
      expect(auth.relayTokenUrls).toEqual([PRIMARY_TOKEN_URL, DOOR_TOKEN_URL])
    }
  })

  it('alternates origins while neither answers, and returns to the auth base after a success', async () => {
    const origin = new RelayRenewalOrigin()
    const seen: (string | undefined)[] = []
    for (let i = 0; i < 4; i++) {
      seen.push(origin.next(FRONT_DOOR))
      origin.failed(new TypeError('fetch failed'), FRONT_DOOR)
    }
    expect(seen).toEqual([undefined, FRONT_DOOR, undefined, FRONT_DOOR])
    origin.failed(new TypeError('fetch failed'), FRONT_DOOR)
    expect(origin.next(FRONT_DOOR)).toBe(FRONT_DOOR)
    origin.succeeded()
    expect(origin.next(FRONT_DOOR)).toBeUndefined()
  })

  it('does not fail over on a 4xx answer from the auth base', async () => {
    const answers: Outcome[] = [401, 403]
    for (const plan of [{ refresh: answers }, { relayToken: answers }]) {
      const auth = fakeAuth(plan)
      const result = await renewUntilSuccess(auth, FRONT_DOOR)
      expect(result.attempts).toBe(3)
      expect(auth.refreshes).toEqual([undefined, undefined, undefined])
      expect(auth.relayTokenUrls.every((url) => url === PRIMARY_TOKEN_URL)).toBe(true)
    }
  })

  it('goes back to the auth base after a 4xx from the authOrigin', () => {
    const origin = new RelayRenewalOrigin()
    origin.failed(new TypeError('fetch failed'), FRONT_DOOR)
    expect(origin.next(FRONT_DOOR)).toBe(FRONT_DOOR)
    origin.failed(new OrcaCloudRequestError(404), FRONT_DOOR)
    expect(origin.next(FRONT_DOOR)).toBeUndefined()
  })

  it('passes a refusal through without another origin', async () => {
    const auth = fakeAuth({})
    const renewal = await renewRelayAuthorization(
      {
        authConfig,
        refreshAccessToken: async () => ({ accessToken: null }),
        keypair,
        fetch: auth.fetch,
        isCurrent: () => true
      },
      undefined
    )
    expect(renewal).toEqual({ kind: 'refused', hostCloseReason: undefined })
    expect(auth.relayTokenUrls).toEqual([])
  })
})

describe('relay token renewal without an authOrigin', () => {
  it('uses only the configured endpoints, as before, whatever fails', async () => {
    const auth = fakeAuth({
      refresh: ['network', 503],
      relayToken: ['network', 503]
    })
    const result = await renewUntilSuccess(auth, undefined)
    expect(result.attempts).toBe(5)
    expect(auth.refreshes).toEqual([undefined, undefined, undefined, undefined, undefined])
    expect(auth.relayTokenUrls).toEqual([PRIMARY_TOKEN_URL, PRIMARY_TOKEN_URL, PRIMARY_TOKEN_URL])
  })
})
