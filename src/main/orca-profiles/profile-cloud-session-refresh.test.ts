import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaCloudAuthConfig } from './profile-cloud-auth-config'
import type { ActiveOrcaProfileState } from './profile-index-store'
import type { OrcaCloudSession } from './profile-cloud-session-store'
import type { OrcaProfileSummary } from '../../shared/orca-profiles'

const store = vi.hoisted(() => {
  const state: { session: OrcaCloudSession | null; signedOut: number } = {
    session: null,
    signedOut: 0
  }
  return state
})

vi.mock('./profile-cloud-session-owner', () => ({
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

import { OrcaCloudRequestError } from './profile-cloud-client'
import {
  readFreshOrcaCloudSession,
  runWithFreshOrcaCloudSession
} from './profile-cloud-session-refresh'

const HOUR_MS = 3_600_000
const SERVER_ROTATION_GRACE_MS = 60_000
const HTML_403 = '<html><body><h1>403 Forbidden</h1></body></html>'
const HTML_502 = '<html><body><h1>502 Bad Gateway</h1></body></html>'

const AUTH = 'https://auth.example.test'
const config: OrcaCloudAuthConfig = {
  apiBaseUrl: AUTH,
  authorizeEndpoint: `${AUTH}/authorize`,
  sessionEndpoint: `${AUTH}/session`,
  refreshEndpoint: `${AUTH}/refresh`,
  capabilitiesEndpoint: `${AUTH}/capabilities`,
  profileEndpoint: `${AUTH}/profile`,
  orgEndpoint: `${AUTH}/org`,
  logoutEndpoint: `${AUTH}/logout`,
  relayTokenEndpoint: `${AUTH}/relay-token`,
  connectorTokenEndpoint: `${AUTH}/connector-token`,
  relayDirectorUrl: AUTH,
  clientId: 'client-1',
  scope: 'openid'
}

let seq = 0
let refreshCalls = 0
let answerRefresh: (refreshToken: string) => Promise<Response>

function reply(status: number, body: string, type = 'application/json'): Response {
  return new Response(body, { status, headers: { 'content-type': type } })
}

function sessionReply(refreshToken: string): Response {
  return reply(
    200,
    JSON.stringify({
      accessToken: `access-${refreshToken}`,
      refreshToken,
      expiresAt: Date.now() + HOUR_MS,
      cloud: { cloudProfileId: 'cloud-profile-1', userId: 'user-1', email: 'a@example.com' },
      capabilities: { flags: {}, refreshedAt: 1 }
    })
  )
}

function signedIn(expired = true): ActiveOrcaProfileState {
  seq += 1
  store.signedOut = 0
  store.session = {
    accessToken: 'access-old',
    refreshToken: `refresh-old-${seq}`,
    expiresAt: expired ? Date.now() - 1 : Date.now() + HOUR_MS,
    capabilities: { flags: {}, refreshedAt: 1 }
  }
  // A fresh profile id keeps the module's single-flight and replay-guard state per test.
  const profile: OrcaProfileSummary = {
    id: `profile-${seq}`,
    name: 'Profile',
    avatar: { kind: 'initials', initials: 'P', color: 'neutral' },
    kind: 'cloud-linked',
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1,
    cloud: {
      userId: 'user-1',
      cloudProfileId: 'cloud-profile-1',
      email: 'a@example.com',
      linkedAt: 1
    }
  }
  return {
    index: { schemaVersion: 1, activeProfileId: profile.id, profiles: [profile] },
    profile,
    dataFile: '',
    stateDatabaseFile: '',
    profileDirectory: ''
  }
}

async function settle(promise: Promise<unknown>): Promise<unknown> {
  const settled = promise.catch(() => 'threw')
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  return settled
}

beforeEach(() => {
  // Response body streams schedule on real immediates; only the request clock is faked.
  vi.useFakeTimers({ now: 1_000_000, toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  // Route request timeouts through fake timers so the timeout chain runs on the test clock.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms)
    return controller.signal
  })
  refreshCalls = 0
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    refreshCalls += 1
    const body: { refreshToken?: unknown } = JSON.parse(String(init.body))
    const refreshToken = String(body.refreshToken)
    return Promise.race([
      answerRefresh(refreshToken),
      new Promise<never>((_, reject) =>
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      )
    ])
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('refresh failures that must keep the sign-in', () => {
  it.each([
    ['403 HTML from a proxy, CDN, WAF or IAM layer', () => reply(403, HTML_403, 'text/html')],
    ['403 JSON', () => reply(403, '{"error":"forbidden"}')],
    ['401 HTML from a proxy', () => reply(401, HTML_403, 'text/html')],
    ['401 JSON without the refresh-token verdict', () => reply(401, '{"error":"invalid_token"}')],
    [
      '401 JSON verdict served as HTML',
      () => reply(401, '{"error":"invalid_refresh_token"}', 'text/html')
    ],
    ['429 rate limited', () => reply(429, '{"error":"rate_limited"}')],
    ['502 HTML', () => reply(502, HTML_502, 'text/html')],
    ['503 JSON', () => reply(503, '{"error":"unavailable"}')]
  ])('%s', async (_name, response) => {
    const active = signedIn()
    answerRefresh = async () => response()

    await settle(readFreshOrcaCloudSession(config, active, '/user-data'))

    expect(store.signedOut).toBe(0)
    expect(store.session).not.toBeNull()
  })
})

describe('refresh rejections that end the sign-in', () => {
  it.each(['signed_out', 'revoked', 'expired', 'reused', undefined])(
    '401 invalid_refresh_token, reason %s',
    async (reason) => {
      const active = signedIn()
      answerRefresh = async () =>
        reply(401, JSON.stringify({ error: 'invalid_refresh_token', reason }))

      const result = await settle(readFreshOrcaCloudSession(config, active, '/user-data'))

      expect(result).toEqual({ status: 'reconnect-required' })
      expect(store.signedOut).toBe(1)
    }
  )
})

describe('a refresh the server committed but answered too slowly', () => {
  it('resolves inside the rotation grace instead of replaying the token after it', async () => {
    const active = signedIn()
    const rotations = new Map<string, { at: number; next: string }>()
    answerRefresh = async (refreshToken) => {
      const prior = rotations.get(refreshToken)
      if (prior) {
        return Date.now() - prior.at < SERVER_ROTATION_GRACE_MS
          ? sessionReply(prior.next)
          : reply(401, '{"error":"invalid_refresh_token","reason":"reused"}')
      }
      rotations.set(refreshToken, { at: Date.now(), next: 'refresh-next' })
      return new Promise<never>(() => undefined)
    }

    const result = await settle(readFreshOrcaCloudSession(config, active, '/user-data'))

    expect(result).toMatchObject({ status: 'found', session: { refreshToken: 'refresh-next' } })
    expect(store.signedOut).toBe(0)
    expect(refreshCalls).toBe(2)
  })
})

describe('operations wrapped in a fresh session', () => {
  it('keeps the sign-in when the operation still answers 401 after a successful refresh', async () => {
    const active = signedIn(false)
    answerRefresh = async () => sessionReply('refresh-next')

    const result = runWithFreshOrcaCloudSession(config, active, '/user-data', async () => {
      throw new OrcaCloudRequestError(401)
    })

    await expect(result).rejects.toBeInstanceOf(OrcaCloudRequestError)
    expect(store.signedOut).toBe(0)
    expect(store.session?.refreshToken).toBe('refresh-next')
  })

  it('does not rotate the token when the operation answers 403', async () => {
    const active = signedIn(false)
    answerRefresh = async () => sessionReply('refresh-next')

    const result = runWithFreshOrcaCloudSession(config, active, '/user-data', async () => {
      throw new OrcaCloudRequestError(403)
    })

    await expect(result).rejects.toMatchObject({ statusCode: 403 })
    expect(refreshCalls).toBe(0)
  })

  it('rotates once for concurrent and repeated 401s within the backoff window', async () => {
    const active = signedIn(false)
    let rotation = 0
    answerRefresh = async () => sessionReply(`refresh-next-${++rotation}`)
    const rejectedCall = (): Promise<unknown> =>
      runWithFreshOrcaCloudSession(config, active, '/user-data', async () => {
        throw new OrcaCloudRequestError(401)
      }).catch((error: unknown) => error)

    const concurrent = await Promise.all([rejectedCall(), rejectedCall(), rejectedCall()])
    await vi.advanceTimersByTimeAsync(60_000)
    const repeated = [await rejectedCall(), await rejectedCall()]

    for (const error of [...concurrent, ...repeated]) {
      expect(error).toMatchObject({ statusCode: 401 })
    }
    expect(refreshCalls).toBe(1)
    expect(store.signedOut).toBe(0)
  })
})
