import { describe, expect, it } from 'vitest'
import type { OrcaCloudAuthConfig } from '../../../orca-profiles/cloud-auth/profile-cloud-auth-config'
import { OrcaCloudRequestError } from '../../../orca-profiles/cloud-auth/profile-cloud-client'
import type { E2EEKeypair } from '../../rpc/server/pairing/e2ee-keypair'
import type { RelayAccessTokenRefresh } from './relay-session-broker-contract'
import {
  RelayRenewalOrigin,
  renewRelayAuthorization,
  type RelayRenewal
} from './relay-renewal-origin'

const AUTH_BASE = 'https://auth.example.test'
const FRONT_DOOR = 'https://front-door.director.example.test'

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

type Outcome = 'ok' | 'network' | 'malformed' | 'local' | 503 | 401 | 403

// The session refresh (always the configured auth base) and one relay-token service per origin.
function fakeAuth(plan: { refresh?: Outcome[]; relayToken?: Outcome[] }) {
  const refreshArgs: unknown[][] = []
  const relayTokenRequests: { url: string; redirect: RequestInit['redirect'] }[] = []
  const refreshPlan = [...(plan.refresh ?? [])]
  const relayTokenPlan = [...(plan.relayToken ?? [])]
  const refreshAccessToken = async (...args: unknown[]): Promise<RelayAccessTokenRefresh> => {
    refreshArgs.push(args)
    const outcome = refreshPlan.shift() ?? 'ok'
    if (outcome === 'network') {
      throw new TypeError('fetch failed')
    }
    if (outcome === 'local') {
      throw new Error('orca_cloud_refresh_replay_blocked')
    }
    if (outcome !== 'ok') {
      throw new OrcaCloudRequestError(outcome === 'malformed' ? 502 : outcome)
    }
    return { accessToken: 'access-token' }
  }
  const fetch: typeof globalThis.fetch = async (url, init) => {
    relayTokenRequests.push({ url: String(url), redirect: init?.redirect })
    const outcome = relayTokenPlan.shift() ?? 'ok'
    if (outcome === 'network') {
      throw new TypeError('fetch failed')
    }
    if (outcome === 'malformed') {
      return new Response('<html>captive portal</html>', { status: 200 })
    }
    if (outcome !== 'ok' && outcome !== 'local') {
      return new Response('{}', { status: outcome })
    }
    return new Response(JSON.stringify({ relayToken: 'relay-jwt', expiresAt: 1_900_000_000 }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }
  return {
    refreshAccessToken,
    fetch,
    refreshArgs,
    relayTokenRequests,
    relayTokenUrls: () => relayTokenRequests.map((request) => request.url)
  }
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

describe('relay token renewal with an authOrigin', () => {
  it('exchanges through the authOrigin after the relay-token POST on the auth base fails 5xx or gets no response', async () => {
    for (const failure of [503, 'network'] as const) {
      const auth = fakeAuth({ relayToken: [failure] })
      const result = await renewUntilSuccess(auth, FRONT_DOOR)
      expect(result.attempts).toBe(2)
      expect(result.renewal).toMatchObject({ kind: 'renewed' })
      expect(auth.relayTokenUrls()).toEqual([PRIMARY_TOKEN_URL, DOOR_TOKEN_URL])
    }
  })

  it('never sends the session refresh to the authOrigin', async () => {
    const auth = fakeAuth({ relayToken: ['network', 'network', 503] })
    const result = await renewUntilSuccess(auth, FRONT_DOOR)
    expect(result.attempts).toBe(4)
    expect(auth.relayTokenUrls()).toEqual([
      PRIMARY_TOKEN_URL,
      DOOR_TOKEN_URL,
      PRIMARY_TOKEN_URL,
      DOOR_TOKEN_URL
    ])
    expect(auth.refreshArgs).toEqual([[], [], [], []])
  })

  it('stays on the auth base when the session refresh fails, whatever the failure', async () => {
    const auth = fakeAuth({ refresh: ['network', 503, 'local', 401] })
    const result = await renewUntilSuccess(auth, FRONT_DOOR)
    expect(result.attempts).toBe(5)
    expect(auth.relayTokenUrls()).toEqual([PRIMARY_TOKEN_URL])
  })

  it('does not fail over on a 4xx answer or a malformed 2xx body from the auth base', async () => {
    const auth = fakeAuth({ relayToken: [401, 403, 'malformed'] })
    const result = await renewUntilSuccess(auth, FRONT_DOOR)
    expect(result.attempts).toBe(4)
    expect(auth.relayTokenUrls()).toEqual([
      PRIMARY_TOKEN_URL,
      PRIMARY_TOKEN_URL,
      PRIMARY_TOKEN_URL,
      PRIMARY_TOKEN_URL
    ])
  })

  it('goes back to the auth base after a 4xx from the authOrigin', async () => {
    const auth = fakeAuth({ relayToken: [503, 403] })
    const result = await renewUntilSuccess(auth, FRONT_DOOR)
    expect(result.attempts).toBe(3)
    expect(auth.relayTokenUrls()).toEqual([PRIMARY_TOKEN_URL, DOOR_TOKEN_URL, PRIMARY_TOKEN_URL])
  })

  it('refuses redirects on the relay-token POST at either origin', async () => {
    const auth = fakeAuth({ relayToken: [503] })
    await renewUntilSuccess(auth, FRONT_DOOR)
    expect(auth.relayTokenRequests).toEqual([
      { url: PRIMARY_TOKEN_URL, redirect: 'error' },
      { url: DOOR_TOKEN_URL, redirect: 'error' }
    ])
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
    expect(auth.relayTokenUrls()).toEqual([])
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
    expect(auth.relayTokenUrls()).toEqual([PRIMARY_TOKEN_URL, PRIMARY_TOKEN_URL, PRIMARY_TOKEN_URL])
  })
})
