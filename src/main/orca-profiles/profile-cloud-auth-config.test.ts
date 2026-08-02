import { describe, expect, it, vi } from 'vitest'
import {
  allowsPlaintextOrcaCloudSession,
  getOrcaCloudAuthConfig,
  isOrcaCloudDevAuthEnabled
} from './profile-cloud-auth-config'

vi.mock('electron', () => ({
  app: {
    isPackaged: false
  }
}))

describe('Orca cloud auth config', () => {
  it('reports unconfigured without both API URL and client ID', () => {
    expect(getOrcaCloudAuthConfig({})).toEqual({
      configured: false,
      setupMessage: 'Orca Cloud sign-in is not configured for this build.'
    })
  })

  it('builds default desktop auth endpoints from the API URL', () => {
    const state = getOrcaCloudAuthConfig({
      ORCA_CLOUD_API_URL: 'https://orca-cloud.example/',
      ORCA_CLOUD_CLIENT_ID: 'desktop-client'
    })

    expect(state).toEqual({
      configured: true,
      config: {
        apiBaseUrl: 'https://orca-cloud.example',
        authorizeEndpoint: 'https://orca-cloud.example/v1/desktop/auth/authorize',
        sessionEndpoint: 'https://orca-cloud.example/v1/desktop/auth/session',
        refreshEndpoint: 'https://orca-cloud.example/v1/desktop/auth/refresh',
        capabilitiesEndpoint: 'https://orca-cloud.example/v1/desktop/auth/capabilities',
        profileEndpoint: 'https://orca-cloud.example/v1/desktop/auth/profile',
        orgEndpoint: 'https://orca-cloud.example/v1/desktop/auth/org',
        logoutEndpoint: 'https://orca-cloud.example/v1/desktop/auth/logout',
        relayTokenEndpoint: 'https://orca-cloud.example/v1/desktop/auth/relay-token',
        relayDirectorUrl: 'https://relay.onorca.dev',
        clientId: 'desktop-client',
        scope: 'openid profile email offline_access'
      }
    })
  })

  it('uses first-party production endpoints without runtime env in packaged builds', () => {
    expect(getOrcaCloudAuthConfig({}, true)).toEqual({
      configured: true,
      config: {
        apiBaseUrl: 'https://login.onorca.dev',
        authorizeEndpoint: 'https://login.onorca.dev/v1/desktop/auth/authorize',
        sessionEndpoint: 'https://login.onorca.dev/v1/desktop/auth/session',
        refreshEndpoint: 'https://login.onorca.dev/v1/desktop/auth/refresh',
        capabilitiesEndpoint: 'https://login.onorca.dev/v1/desktop/auth/capabilities',
        profileEndpoint: 'https://login.onorca.dev/v1/desktop/auth/profile',
        orgEndpoint: 'https://login.onorca.dev/v1/desktop/auth/org',
        logoutEndpoint: 'https://login.onorca.dev/v1/desktop/auth/logout',
        relayTokenEndpoint: 'https://login.onorca.dev/v1/desktop/auth/relay-token',
        relayDirectorUrl: 'https://relay.onorca.dev',
        clientId: 'orca-desktop',
        scope: 'openid profile email offline_access'
      }
    })
  })

  it('allows loopback HTTP endpoints for local desktop auth development', () => {
    const state = getOrcaCloudAuthConfig({
      ORCA_CLOUD_API_URL: 'http://localhost:4100',
      ORCA_CLOUD_CLIENT_ID: 'desktop-client'
    })

    expect(state.configured).toBe(true)
  })

  it('rejects loopback HTTP endpoints in packaged builds', () => {
    expect(
      getOrcaCloudAuthConfig(
        {
          ORCA_CLOUD_API_URL: 'http://localhost:4100',
          ORCA_CLOUD_CLIENT_ID: 'desktop-client'
        },
        true
      )
    ).toMatchObject({ configured: false })

    const httpsState = getOrcaCloudAuthConfig(
      {
        ORCA_CLOUD_API_URL: 'https://orca-cloud.example',
        ORCA_CLOUD_CLIENT_ID: 'desktop-client'
      },
      true
    )
    expect(httpsState.configured).toBe(true)
  })

  it('rejects non-HTTPS non-loopback API URLs', () => {
    expect(
      getOrcaCloudAuthConfig({
        ORCA_CLOUD_API_URL: 'http://orca-cloud.example',
        ORCA_CLOUD_CLIENT_ID: 'desktop-client'
      })
    ).toMatchObject({ configured: false })
  })

  it('allows dev plaintext sessions only outside production', () => {
    expect(
      allowsPlaintextOrcaCloudSession({
        ORCA_CLOUD_ALLOW_PLAINTEXT_SESSION: '1',
        NODE_ENV: 'development'
      })
    ).toBe(true)
    expect(
      allowsPlaintextOrcaCloudSession({
        ORCA_CLOUD_ALLOW_PLAINTEXT_SESSION: '1',
        NODE_ENV: 'production'
      })
    ).toBe(false)
  })

  it('ignores dev flags in packaged builds even without NODE_ENV', () => {
    // Why: packaged main bundles never define NODE_ENV, so packaged-ness must
    // gate the escape hatches on its own.
    expect(allowsPlaintextOrcaCloudSession({ ORCA_CLOUD_ALLOW_PLAINTEXT_SESSION: '1' }, true)).toBe(
      false
    )
    expect(isOrcaCloudDevAuthEnabled({ ORCA_CLOUD_DEV_AUTH: '1' }, true)).toBe(false)
  })

  it('allows local dev auth only outside production', () => {
    expect(
      isOrcaCloudDevAuthEnabled({
        ORCA_CLOUD_DEV_AUTH: '1',
        NODE_ENV: 'development'
      })
    ).toBe(true)
    expect(
      isOrcaCloudDevAuthEnabled({
        ORCA_CLOUD_DEV_AUTH: '1',
        NODE_ENV: 'production'
      })
    ).toBe(false)
  })
})
