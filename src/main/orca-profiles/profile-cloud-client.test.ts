import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelTrackingResponse } from '../lib/unread-response-body.test-fixtures'
import type { OrcaCloudAuthConfig } from './profile-cloud-auth-config'
import type { OrcaCloudSession } from './profile-cloud-session-store'
import { refreshOrcaCloudCapabilities } from './profile-cloud-client'

const fetchMock = vi.fn()

const config: OrcaCloudAuthConfig = {
  apiBaseUrl: 'https://orca-cloud.example',
  authorizeEndpoint: 'https://orca-cloud.example/v1/desktop/auth/authorize',
  sessionEndpoint: 'https://orca-cloud.example/v1/desktop/auth/session',
  refreshEndpoint: 'https://orca-cloud.example/v1/desktop/auth/refresh',
  capabilitiesEndpoint: 'https://orca-cloud.example/v1/desktop/auth/capabilities',
  profileEndpoint: 'https://orca-cloud.example/v1/desktop/auth/profile',
  orgEndpoint: 'https://orca-cloud.example/v1/desktop/auth/org',
  logoutEndpoint: 'https://orca-cloud.example/v1/desktop/auth/logout',
  relayTokenEndpoint: 'https://orca-cloud.example/v1/desktop/auth/relay-token',
  connectorTokenEndpoint: 'https://orca-cloud.example/v1/desktop/auth/connector-token',
  relayDirectorUrl: 'https://relay.example',
  clientId: 'desktop-client',
  scope: 'openid profile email offline_access'
}

const session: OrcaCloudSession = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresAt: 999,
  capabilities: { flags: { share: true }, refreshedAt: 1 }
}

describe('Orca cloud client', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('cancels the unread error-response body so bundled undici cannot crash on socket close', async () => {
    let cancelledBodies = 0
    fetchMock.mockResolvedValue(
      cancelTrackingResponse(502, () => {
        cancelledBodies += 1
      })
    )

    await expect(refreshOrcaCloudCapabilities(config, session)).rejects.toThrow()
    expect(cancelledBodies).toBe(1)
  })
})
