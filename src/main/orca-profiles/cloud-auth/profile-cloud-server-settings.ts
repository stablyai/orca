import { getMainHttpClient } from '../../network/http-client'
import {
  DEFAULT_CLOUD_SERVER,
  validateCustomCloudServer,
  type CloudServerConnectionTest,
  type CustomCloudServerSettings
} from '../../../shared/settings/custom-cloud-server'
import type { Store } from '../../persistence/loading-store/store'
import type { OrcaAccountService } from '../orca-account-service'
import type { OrcaRuntimeRpcServer } from '../../runtime/rpc/server/runtime-rpc'
import { getOrcaCloudAuthConfig } from './profile-cloud-auth-config'
import { cancelUnreadResponseBody } from '../../lib/unread-response-body'
import { readFetchResponseJsonWithinLimit } from '../../../shared/network/fetch-response-body'

export function requireCustomCloudServer(
  value: unknown,
  packaged: boolean
): CustomCloudServerSettings {
  const settings = validateCustomCloudServer(value, !packaged)
  if (!settings) {
    throw new Error('invalid_custom_cloud_server')
  }
  return settings
}

export async function testCloudServerConnection(
  value: unknown,
  packaged: boolean
): Promise<CloudServerConnectionTest> {
  const settings = requireCustomCloudServer(value, packaged)
  const probe = async (url: string, field: 'keys' | 'regions'): Promise<boolean> => {
    try {
      const response = await getMainHttpClient().fetch(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000)
      })
      if (!response.ok) {
        await cancelUnreadResponseBody(response)
        return false
      }
      const body = await readFetchResponseJsonWithinLimit<Record<string, unknown>>(
        response,
        64 * 1024
      )
      return Array.isArray(body?.[field])
    } catch {
      return false
    }
  }
  const [relay, auth] = await Promise.all([
    probe(`${settings.relayDirectorUrl}/v1/regions`, 'regions'),
    probe(new URL('/.well-known/jwks.json', settings.authServerUrl).toString(), 'keys')
  ])
  return { auth, relay }
}

type SwitchCloudServerPorts = {
  store: Store
  account: OrcaAccountService
  runtimeRpc: OrcaRuntimeRpcServer
  packaged: boolean
  stopRelay: () => void
  restartRelay: () => void
}

export async function switchCloudServer(
  value: unknown,
  ports: SwitchCloudServerPorts
): Promise<CustomCloudServerSettings> {
  const settings = requireCustomCloudServer(value, ports.packaged)
  const previous = ports.store.getSettings().customCloudServer ?? DEFAULT_CLOUD_SERVER
  return ports.account.withCloudServerSwitch(async (serverChanging) => {
    const oldConfig = getOrcaCloudAuthConfig(process.env, ports.packaged, previous)
    const nextConfig = getOrcaCloudAuthConfig(process.env, ports.packaged, settings)
    const unchanged =
      oldConfig.configured && nextConfig.configured
        ? oldConfig.config.apiBaseUrl === nextConfig.config.apiBaseUrl &&
          oldConfig.config.clientId === nextConfig.config.clientId &&
          oldConfig.config.relayDirectorUrl === nextConfig.config.relayDirectorUrl
        : !oldConfig.configured && !nextConfig.configured
    const persist = () =>
      ports.store.updateSettingsAndFlush({ customCloudServer: settings }, { notifyListeners: true })
    if (unchanged) {
      await persist()
      return settings
    }
    serverChanging()
    // Stop the installer as well as the broker before awaiting any network or disk work.
    ports.stopRelay()
    try {
      await ports.runtimeRpc.revokeCloudRelayPairings(
        oldConfig.configured ? oldConfig.config.relayDirectorUrl : null
      )
      await ports.account.signOut()
      await persist()
      return settings
    } finally {
      ports.restartRelay()
    }
  })
}
