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
