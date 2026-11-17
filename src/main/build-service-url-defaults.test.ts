import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

import { resolveArtifactCloudApiUrl } from './artifacts/artifact-cloud-config'
import { resolveConnectorOrigin } from './connector-cloud/connector-origin'
import { getOrcaCloudAuthConfig } from './orca-profiles/cloud-auth/profile-cloud-auth-config'
import { resolvePushGatewayOrigin } from './runtime/push/push-gateway-origin'

const authApiUrl = (env: NodeJS.ProcessEnv, packaged: boolean): string | null => {
  const result = getOrcaCloudAuthConfig({ ORCA_CLOUD_CLIENT_ID: 'client', ...env }, packaged)
  return result.configured ? result.config.apiBaseUrl : null
}
const relayDirectorUrl = (env: NodeJS.ProcessEnv, packaged: boolean): string | null => {
  const devAuth = packaged ? {} : { ORCA_CLOUD_API_URL: 'http://127.0.0.1:8788' }
  const result = getOrcaCloudAuthConfig(
    { ORCA_CLOUD_CLIENT_ID: 'client', ...devAuth, ...env },
    packaged
  )
  return result.configured ? result.config.relayDirectorUrl : null
}

// Each row: build-default key, dev run-time env name, resolver, and today's packaged literal.
const cases = [
  {
    key: 'authApiUrl',
    envName: 'ORCA_CLOUD_API_URL',
    resolve: authApiUrl,
    literal: 'https://login.onorca.dev'
  },
  {
    key: 'relayDirectorUrl',
    envName: 'ORCA_RELAY_URL',
    resolve: relayDirectorUrl,
    literal: 'https://relay.onorca.dev'
  },
  {
    key: 'pushGatewayUrl',
    envName: 'ORCA_PUSH_GATEWAY_URL',
    resolve: resolvePushGatewayOrigin,
    literal: 'https://push.onorca.dev'
  },
  {
    key: 'connectorUrl',
    envName: 'ORCA_CONNECTOR_URL',
    resolve: resolveConnectorOrigin,
    literal: 'https://connector.onorca.dev'
  },
  {
    key: 'artifactsApiUrl',
    envName: 'ORCA_ARTIFACTS_API_URL',
    resolve: (env: NodeJS.ProcessEnv, packaged: boolean) =>
      resolveArtifactCloudApiUrl(undefined, env, packaged),
    literal: 'https://share.onorca.dev'
  }
]

describe('build-time service URL defaults', () => {
  afterEach(() => vi.unstubAllGlobals())

  describe.each(cases)('$key', ({ key, envName, resolve, literal }) => {
    it('keeps the current default when the build sets none', () => {
      expect(resolve({}, true)).toBe(literal)
      vi.stubGlobal('ORCA_CLOUD_BUILD_DEFAULTS', { billingApiUrl: 'https://billing.example' })
      expect(resolve({}, true)).toBe(literal)
    })

    it('uses the build default when set', () => {
      vi.stubGlobal('ORCA_CLOUD_BUILD_DEFAULTS', { [key]: 'https://build.onorca.dev' })
      expect(resolve({}, true)).toBe('https://build.onorca.dev')
    })

    it('lets the development run-time override win over the build default', () => {
      vi.stubGlobal('ORCA_CLOUD_BUILD_DEFAULTS', { [key]: 'https://build.onorca.dev' })
      expect(resolve({ [envName]: 'http://127.0.0.1:8787' }, false)).toBe('http://127.0.0.1:8787')
    })
  })
})
