import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaCloudAuthConfig } from '../cloud-auth/profile-cloud-auth-config'
import { OrcaCloudRequestError, refreshOrcaCloudSession } from '../cloud-auth/profile-cloud-client'
import type { OrcaCloudSession } from './profile-cloud-session-store'
import {
  getReconnectReason,
  reconnectReasonFromRefusal,
  rememberReconnectReason
} from './profile-cloud-reconnect-reason'

const base = 'https://auth.test'
const config: OrcaCloudAuthConfig = {
  apiBaseUrl: base,
  authorizeEndpoint: `${base}/a`,
  sessionEndpoint: `${base}/s`,
  refreshEndpoint: `${base}/r`,
  capabilitiesEndpoint: `${base}/c`,
  profileEndpoint: `${base}/p`,
  orgEndpoint: `${base}/o`,
  logoutEndpoint: `${base}/l`,
  relayTokenEndpoint: `${base}/rt`,
  connectorTokenEndpoint: `${base}/ct`,
  relayDirectorUrl: base,
  clientId: 'orca-desktop',
  scope: 'openid'
}
const session: OrcaCloudSession = {
  accessToken: 'token',
  refreshToken: 'refresh',
  expiresAt: 0,
  capabilities: { flags: {}, refreshedAt: 0 }
}

afterEach(() => {
  vi.unstubAllGlobals()
  rememberReconnectReason('p1', undefined)
})

async function refusal(body: unknown): Promise<unknown> {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 401,
          headers: { 'content-type': 'application/json' }
        })
    )
  )
  return refreshOrcaCloudSession(config, session).catch((error: unknown) => error)
}

describe('why a sign-in ended', () => {
  it('a refused refresh carries auth’s reason beside its error', async () => {
    const error = await refusal({ error: 'invalid_refresh_token', reason: 'sso_required' })
    expect(error).toBeInstanceOf(OrcaCloudRequestError)
    expect(error).toMatchObject({
      statusCode: 401,
      errorCode: 'invalid_refresh_token',
      reason: 'sso_required'
    })
  })

  it('an older auth with no reason, or a non-string one, reads as none', async () => {
    expect(await refusal({ error: 'invalid_refresh_token' })).toMatchObject({ reason: undefined })
    expect(await refusal({ error: 'invalid_refresh_token', reason: 7 })).toMatchObject({
      reason: undefined
    })
  })

  it('only single sign-on is told apart; every other reason stays the generic sign-in-again', () => {
    expect(reconnectReasonFromRefusal('sso_required')).toBe('sso-required')
    for (const reason of [
      'expired',
      'signed_out',
      'revoked',
      'reused',
      'something_new',
      undefined
    ]) {
      expect(reconnectReasonFromRefusal(reason)).toBeUndefined()
    }
  })

  it('is remembered per profile and cleared by a refusal without one', () => {
    rememberReconnectReason('p1', 'sso-required')
    expect(getReconnectReason('p1')).toBe('sso-required')
    expect(getReconnectReason('p2')).toBeUndefined()
    rememberReconnectReason('p1', undefined)
    expect(getReconnectReason('p1')).toBeUndefined()
  })
})
