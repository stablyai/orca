import { describe, expect, it, vi } from 'vitest'
import {
  allowsPlaintextMCodeCloudSession,
  getMCodeCloudAuthConfig,
  isMCodeCloudDevAuthEnabled
} from './profile-cloud-auth-config'

vi.mock('electron', () => ({
  app: {
    isPackaged: false
  }
}))

describe('MCode cloud auth config', () => {
  it('reports unconfigured without both API URL and client ID', () => {
    expect(getMCodeCloudAuthConfig({})).toEqual({
      configured: false,
      setupMessage: 'MCode Cloud sign-in is not configured for this build.'
    })
  })

  it('builds default desktop auth endpoints from the API URL', () => {
    const state = getMCodeCloudAuthConfig({
      MCODE_CLOUD_API_URL: 'https://mcode-cloud.example/',
      MCODE_CLOUD_CLIENT_ID: 'desktop-client'
    })

    expect(state).toEqual({
      configured: true,
      config: {
        apiBaseUrl: 'https://mcode-cloud.example',
        authorizeEndpoint: 'https://mcode-cloud.example/v1/desktop/auth/authorize',
        sessionEndpoint: 'https://mcode-cloud.example/v1/desktop/auth/session',
        refreshEndpoint: 'https://mcode-cloud.example/v1/desktop/auth/refresh',
        capabilitiesEndpoint: 'https://mcode-cloud.example/v1/desktop/auth/capabilities',
        profileEndpoint: 'https://mcode-cloud.example/v1/desktop/auth/profile',
        orgEndpoint: 'https://mcode-cloud.example/v1/desktop/auth/org',
        logoutEndpoint: 'https://mcode-cloud.example/v1/desktop/auth/logout',
        relayTokenEndpoint: 'https://mcode-cloud.example/v1/desktop/auth/relay-token',
        relayDirectorUrl: 'https://relay.mcode.dev',
        clientId: 'desktop-client',
        scope: 'openid profile email offline_access'
      }
    })
  })

  it('uses first-party production endpoints without runtime env in packaged builds', () => {
    expect(getMCodeCloudAuthConfig({}, true)).toEqual({
      configured: true,
      config: {
        apiBaseUrl: 'https://login.mcode.dev',
        authorizeEndpoint: 'https://login.mcode.dev/v1/desktop/auth/authorize',
        sessionEndpoint: 'https://login.mcode.dev/v1/desktop/auth/session',
        refreshEndpoint: 'https://login.mcode.dev/v1/desktop/auth/refresh',
        capabilitiesEndpoint: 'https://login.mcode.dev/v1/desktop/auth/capabilities',
        profileEndpoint: 'https://login.mcode.dev/v1/desktop/auth/profile',
        orgEndpoint: 'https://login.mcode.dev/v1/desktop/auth/org',
        logoutEndpoint: 'https://login.mcode.dev/v1/desktop/auth/logout',
        relayTokenEndpoint: 'https://login.mcode.dev/v1/desktop/auth/relay-token',
        relayDirectorUrl: 'https://relay.mcode.dev',
        clientId: 'mcode-desktop',
        scope: 'openid profile email offline_access'
      }
    })
  })

  it('allows loopback HTTP endpoints for local desktop auth development', () => {
    const state = getMCodeCloudAuthConfig({
      MCODE_CLOUD_API_URL: 'http://localhost:4100',
      MCODE_CLOUD_CLIENT_ID: 'desktop-client'
    })

    expect(state.configured).toBe(true)
  })

  it('rejects loopback HTTP endpoints in packaged builds', () => {
    expect(
      getMCodeCloudAuthConfig(
        {
          MCODE_CLOUD_API_URL: 'http://localhost:4100',
          MCODE_CLOUD_CLIENT_ID: 'desktop-client'
        },
        true
      )
    ).toMatchObject({ configured: false })

    const httpsState = getMCodeCloudAuthConfig(
      {
        MCODE_CLOUD_API_URL: 'https://mcode-cloud.example',
        MCODE_CLOUD_CLIENT_ID: 'desktop-client'
      },
      true
    )
    expect(httpsState.configured).toBe(true)
  })

  it('rejects non-HTTPS non-loopback API URLs', () => {
    expect(
      getMCodeCloudAuthConfig({
        MCODE_CLOUD_API_URL: 'http://mcode-cloud.example',
        MCODE_CLOUD_CLIENT_ID: 'desktop-client'
      })
    ).toMatchObject({ configured: false })
  })

  it('allows dev plaintext sessions only outside production', () => {
    expect(
      allowsPlaintextMCodeCloudSession({
        MCODE_CLOUD_ALLOW_PLAINTEXT_SESSION: '1',
        NODE_ENV: 'development'
      })
    ).toBe(true)
    expect(
      allowsPlaintextMCodeCloudSession({
        MCODE_CLOUD_ALLOW_PLAINTEXT_SESSION: '1',
        NODE_ENV: 'production'
      })
    ).toBe(false)
  })

  it('ignores dev flags in packaged builds even without NODE_ENV', () => {
    // Why: packaged main bundles never define NODE_ENV, so packaged-ness must
    // gate the escape hatches on its own.
    expect(allowsPlaintextMCodeCloudSession({ MCODE_CLOUD_ALLOW_PLAINTEXT_SESSION: '1' }, true)).toBe(
      false
    )
    expect(isMCodeCloudDevAuthEnabled({ MCODE_CLOUD_DEV_AUTH: '1' }, true)).toBe(false)
  })

  it('allows local dev auth only outside production', () => {
    expect(
      isMCodeCloudDevAuthEnabled({
        MCODE_CLOUD_DEV_AUTH: '1',
        NODE_ENV: 'development'
      })
    ).toBe(true)
    expect(
      isMCodeCloudDevAuthEnabled({
        MCODE_CLOUD_DEV_AUTH: '1',
        NODE_ENV: 'production'
      })
    ).toBe(false)
  })
})
