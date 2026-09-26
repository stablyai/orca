import { cleanCloudServiceOrigin } from '../../../shared/cloud-service-url'
import type { RelayAuthContext } from './relay-auth-coordinator'
import type { SelfHostedRelaySettings } from '../../../shared/mobile-relay-provider'

export type SelfHostedRelayConfig = {
  relayDirectorUrl: string
  relayTokenEndpoint: string
  accessKey: string
}

export function getSelfHostedRelayConfig(
  settings: SelfHostedRelaySettings,
  packaged: boolean
): SelfHostedRelayConfig {
  const url = settings.url.trim()
  const accessKey = settings.accessKey.trim()
  const relayDirectorUrl = cleanCloudServiceOrigin(url, !packaged)
  if (
    !relayDirectorUrl ||
    !url ||
    new URL(url).username ||
    new URL(url).password ||
    !accessKey ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(accessKey)
  ) {
    throw new Error('Self-hosted Relay requires an HTTPS origin and a 32–256 character access key.')
  }
  return {
    relayDirectorUrl,
    relayTokenEndpoint: `${relayDirectorUrl}/v1/host-token`,
    accessKey
  }
}

export function selfHostedRelayAuthContext(config: SelfHostedRelayConfig): RelayAuthContext {
  return {
    identity: { userId: 'self-hosted', profileId: config.relayDirectorUrl, organizationId: '' },
    accessToken: config.accessKey,
    relayEntitled: true
  }
}
