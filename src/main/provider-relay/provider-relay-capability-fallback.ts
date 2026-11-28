import type { DaemonEndpointIdentity } from '../daemon/protocol/daemon-hello-protocol'
import type { ProviderRelayCapability } from '../daemon/protocol/daemon-provider-relay-protocol'
import { startSpan } from '../observability/tracer'

const traced = new Set<string>()

/** The capability a relayed launch needs that this daemon doesn't advertise, if any. */
export function missingProviderRelayCapability(
  identity: DaemonEndpointIdentity | null,
  keep: boolean
): ProviderRelayCapability | null {
  if (!identity?.providerRelay) {
    return 'providerRelay'
  }
  return keep && !identity.providerRelayKeep ? 'providerRelayKeep' : null
}

/** Records once per daemon start and capability that its chats launch direct, and why. */
export function traceProviderRelayCapabilityFallback(
  identity: DaemonEndpointIdentity | null,
  capability: ProviderRelayCapability
): void {
  const key = `${identity?.launchNonce ?? ''}:${capability}`
  if (traced.has(key)) {
    return
  }
  traced.add(key)
  const daemonAppVersion = identity?.appVersion ?? 'unknown'
  startSpan('provider-relay.direct-fallback', {
    attributes: { capability, daemonAppVersion, daemonPid: identity?.pid ?? null }
  }).end()
  console.warn(
    `[provider-relay] daemon from ${daemonAppVersion} lacks ${capability}; chats launch direct`
  )
}
