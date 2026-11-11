import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaCloudAuthConfig } from '../cloud-auth/profile-cloud-auth-config'
import type { ActiveOrcaProfileState } from '../profile-index-store'
import type { OrcaCloudSession } from './profile-cloud-session-store'
import type { OrcaProfileSummary } from '../../../shared/orca-profiles'

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

import { OrcaCloudRequestError } from '../cloud-auth/profile-cloud-client'
import { runWithFreshOrcaCloudSession } from './profile-cloud-session-refresh'

const HOUR_MS = 3_600_000

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

describe('operations wrapped in a fresh session', () => {
  it('does not rotate the token when the operation answers 403', async () => {
    const active = signedIn(false)
    answerRefresh = async () => sessionReply('refresh-next')

    const result = runWithFreshOrcaCloudSession(config, active, '/user-data', async () => {
      throw new OrcaCloudRequestError(403)
    })

    await expect(result).rejects.toMatchObject({ statusCode: 403 })
    expect(refreshCalls).toBe(0)
  })
})
