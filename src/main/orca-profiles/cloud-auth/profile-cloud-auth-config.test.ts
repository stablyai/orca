import { requiresExplicitCloudServiceUrl } from './profile-cloud-server-preferences'
import { afterEach, describe, expect, it } from 'vitest'
import { installFakeAppEnvironment } from '../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import { hasAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import {
  allowsPlaintextOrcaCloudSession,
  getOrcaCloudAuthConfig,
  getOrcaPushGatewayUrl,
  isOrcaCloudDevAuthEnabled
} from './profile-cloud-auth-config'

const DEV_OVERRIDES = {
  ORCA_CLOUD_API_URL: 'http://127.0.0.1:8787',
  ORCA_CLOUD_CLIENT_ID: 'local-client',
  ORCA_RELAY_URL: 'http://127.0.0.1:9000',
  ORCA_CLOUD_DEV_AUTH: '1',
  ORCA_CLOUD_ALLOW_PLAINTEXT_SESSION: '1'
}

describe('Orca cloud auth config read from the installed app environment', () => {
  afterEach(() => installFakeAppEnvironment())

  it('refuses dev auth, plaintext sessions and HTTP endpoints in a packaged host', () => {
    installFakeAppEnvironment({ isPackaged: () => true })

    expect(isOrcaCloudDevAuthEnabled(DEV_OVERRIDES)).toBe(false)
    expect(allowsPlaintextOrcaCloudSession(DEV_OVERRIDES)).toBe(false)
    expect(getOrcaCloudAuthConfig(DEV_OVERRIDES)).toEqual({
      configured: false,
      setupMessage: 'Orca Cloud sign-in is not configured for this build.'
    })
    expect(getOrcaPushGatewayUrl({ ORCA_PUSH_GATEWAY_URL: 'http://127.0.0.1:9000' })).toBe(
      'https://push.onorca.dev'
    )
    expect(getOrcaCloudAuthConfig({})).toMatchObject({
      configured: true,
      config: { apiBaseUrl: 'https://login.onorca.dev', clientId: 'orca-desktop' }
    })
  })

  it('allows the dev overrides in an unpackaged host', () => {
    installFakeAppEnvironment({ isPackaged: () => false })

    expect(isOrcaCloudDevAuthEnabled(DEV_OVERRIDES)).toBe(true)
    expect(allowsPlaintextOrcaCloudSession(DEV_OVERRIDES)).toBe(true)
    expect(getOrcaCloudAuthConfig(DEV_OVERRIDES)).toMatchObject({
      configured: true,
      config: { apiBaseUrl: 'http://127.0.0.1:8787', clientId: 'local-client' }
    })
    expect(getOrcaCloudAuthConfig({})).toMatchObject({ configured: false })
  })

  it('reads as unpackaged when no app environment is installed, as a bare Node import did', () => {
    // Test setup installs a fake environment, and there is no uninstall API.
    Reflect.deleteProperty(globalThis, Symbol.for('orca.host.appEnvironment'))
    expect(hasAppEnvironment()).toBe(false)

    expect(isOrcaCloudDevAuthEnabled(DEV_OVERRIDES)).toBe(true)
    expect(getOrcaCloudAuthConfig({})).toMatchObject({ configured: false })
  })
})

it('resolves environment overrides before the enabled saved server and production defaults', () => {
  const saved = {
    enabled: true,
    authServerUrl: 'https://auth.example.test',
    clientId: 'self-hosted',
    relayDirectorUrl: 'https://relay.example.test'
  }
  expect(getOrcaCloudAuthConfig({}, true, saved)).toMatchObject({
    configured: true,
    config: {
      apiBaseUrl: 'https://auth.example.test',
      clientId: 'self-hosted',
      relayDirectorUrl: 'https://relay.example.test'
    }
  })
  expect(
    getOrcaCloudAuthConfig(
      {
        ORCA_CLOUD_API_URL: 'https://env.example.test',
        ORCA_CLOUD_CLIENT_ID: 'environment',
        ORCA_RELAY_URL: 'https://env-relay.example.test'
      },
      true,
      saved
    )
  ).toMatchObject({
    configured: true,
    config: {
      apiBaseUrl: 'https://env.example.test',
      clientId: 'environment',
      relayDirectorUrl: 'https://env-relay.example.test'
    }
  })
  expect(getOrcaCloudAuthConfig({}, true, { ...saved, enabled: false })).toMatchObject({
    configured: true,
    config: {
      apiBaseUrl: 'https://login.onorca.dev',
      clientId: 'orca-desktop',
      relayDirectorUrl: 'https://relay.onorca.dev'
    }
  })
})

it('requires a complete environment server triple and never fills missing fields from saved settings', () => {
  const saved = {
    enabled: true,
    authServerUrl: 'https://custom-auth.example.test',
    clientId: 'custom-client',
    relayDirectorUrl: 'https://custom-relay.example.test'
  }
  expect(
    getOrcaCloudAuthConfig({ ORCA_RELAY_URL: 'https://relay.onorca.dev' }, true, saved)
  ).toMatchObject({ configured: false })
  expect(
    getOrcaCloudAuthConfig({ ORCA_CLOUD_API_URL: 'https://env-auth.example.test' }, false, saved)
  ).toMatchObject({ configured: false })
  expect(
    getOrcaCloudAuthConfig(
      { ORCA_CLOUD_API_URL: 'https://env-auth.example.test', ORCA_CLOUD_CLIENT_ID: 'env-client' },
      true,
      saved
    )
  ).toMatchObject({ configured: false })
  expect(
    getOrcaCloudAuthConfig(
      {
        ORCA_CLOUD_API_URL: 'https://env-auth.example.test',
        ORCA_CLOUD_CLIENT_ID: 'env-client',
        ORCA_RELAY_URL: 'https://env-relay.example.test'
      },
      false,
      saved
    )
  ).toMatchObject({
    configured: true,
    config: {
      apiBaseUrl: 'https://env-auth.example.test',
      clientId: 'env-client',
      relayDirectorUrl: 'https://env-relay.example.test'
    }
  })
  expect(getOrcaCloudAuthConfig({}, false, undefined)).toMatchObject({ configured: false })
})

it('requires an explicit service URL for the effective server, ignoring overridden saved settings', () => {
  const saved = {
    enabled: true,
    authServerUrl: 'https://custom-auth.example.test',
    clientId: 'custom-client',
    relayDirectorUrl: 'https://custom-relay.example.test'
  }
  const resolve = (env: NodeJS.ProcessEnv, enabled = true) => {
    const result = getOrcaCloudAuthConfig(env, true, { ...saved, enabled })
    if (!result.configured) {
      throw new Error(result.setupMessage)
    }
    return result.config
  }
  const production = resolve({
    ORCA_CLOUD_API_URL: 'https://login.onorca.dev/',
    ORCA_CLOUD_CLIENT_ID: 'orca-desktop',
    ORCA_RELAY_URL: 'https://relay.onorca.dev/'
  })
  expect(requiresExplicitCloudServiceUrl(production)).toBe(false)
  const custom = resolve(
    {
      ORCA_CLOUD_API_URL: 'https://env-auth.example.test',
      ORCA_CLOUD_CLIENT_ID: 'environment',
      ORCA_RELAY_URL: 'https://env-relay.example.test'
    },
    false
  )
  expect(requiresExplicitCloudServiceUrl(custom)).toBe(true)
  expect(requiresExplicitCloudServiceUrl(custom, 'https://share.example.test')).toBe(false)
  expect(requiresExplicitCloudServiceUrl(resolve({}))).toBe(true)
  expect(requiresExplicitCloudServiceUrl(resolve({}, false))).toBe(false)
})
