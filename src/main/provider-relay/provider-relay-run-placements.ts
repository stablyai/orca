import type { DaemonClient } from '../daemon/transport/client/daemon-client'
import type { AgentSessionRunPlacementLaunch } from '../../shared/agent-session/lifecycle/agent-session-run-placement'
import { forgetProviderRelayRunVerdict } from './provider-relay-launch-inventory'

/** Where each chat's current launch started its run, taken once by the process commit. */
const placements = new Map<string, AgentSessionRunPlacementLaunch>()

/** No entry means the run started in this app (relaying unavailable, or another provider). */
export function takeProviderRelayRunPlacement(chatKey: string): AgentSessionRunPlacementLaunch {
  const placement = placements.get(chatKey) ?? { kind: 'direct' }
  placements.delete(chatKey)
  // The new run replaces the one any earlier ask was about.
  forgetProviderRelayRunVerdict(chatKey)
  return placement
}

export function forgetProviderRelayRunPlacement(chatKey: string): void {
  placements.delete(chatKey)
}

/** `echoed`: the daemon start the reply named, which a reconnect's newer hello can't replace. */
export function noteProviderRelayRunPlacement(
  chatKey: string,
  client: DaemonClient,
  relayId: string,
  echoed?: string
): void {
  const identity = client.getDaemonIdentity()
  const instance = echoed ?? identity?.launchNonce
  // A hello from another start than the reply's can't vouch for the daemon's pid.
  if (identity && instance && identity.launchNonce === instance) {
    const { pid, startedAtMs } = identity
    placements.set(chatKey, { kind: 'relayed', relayId, daemon: { instance, pid, startedAtMs } })
  }
}
