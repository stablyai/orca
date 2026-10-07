import { publicKeyFromBase64 } from '../../shared/e2ee-crypto'
import type { PairingOffer } from '../../shared/pairing'
import type { RuntimeHostStatusSnapshot } from '../../shared/runtime-host-status'
import { classifyRemotePairingHostname } from '../../shared/remote-pairing-address'
import {
  resolveEnvironment,
  updateEnvironmentRelayRoute
} from '../../shared/runtime-environment-store'
import {
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { RuntimeEnvironmentRelayBridge } from './runtime-environment-relay-bridge'

const bridges = new Map<string, { key: string; bridge: RuntimeEnvironmentRelayBridge }>()

/**
 * The pairing a client transport should dial. Relay-capable environments get their in-process
 * bridge, which tries the paired endpoint first and falls back to Orca Relay; others are unchanged.
 * Identity checks must keep using `getPreferredPairingOffer`, which names the real server key.
 */
export function getRuntimeEnvironmentConnectPairing(
  userDataPath: string,
  environment: KnownRuntimeEnvironment
): PairingOffer {
  const pairing = getPreferredPairingOffer(environment)
  if (!environment.relay) {
    disposeRuntimeEnvironmentRelayBridge(environment.id)
    return pairing
  }
  const key = [
    userDataPath,
    environment.pairingRevision ?? environment.createdAt,
    pairing.endpoint,
    pairing.deviceToken,
    pairing.publicKeyB64,
    environment.connectionDependency ?? ''
  ].join('\0')
  let cached = bridges.get(environment.id)
  if (!cached || cached.key !== key) {
    cached?.bridge.dispose()
    cached = {
      key,
      bridge: new RuntimeEnvironmentRelayBridge({
        environmentId: environment.id,
        deviceToken: pairing.deviceToken,
        hostPublicKey: publicKeyFromBase64(pairing.publicKeyB64),
        directEndpoint: isDirectEndpointUsable(environment, pairing) ? pairing.endpoint : null,
        readRoute: () => readRelayRoute(userDataPath, environment.id),
        writeRoute: (update) => {
          updateEnvironmentRelayRoute(userDataPath, environment.id, update)
        }
      })
    }
    bridges.set(environment.id, cached)
  }
  return {
    ...pairing,
    endpoint: cached.bridge.endpoint,
    publicKeyB64: cached.bridge.publicKeyB64
  }
}

/** Annotates a status snapshot with the route its connection took; Relay-less servers are always direct. */
export function withRuntimeEnvironmentRoute(
  snapshot: RuntimeHostStatusSnapshot
): RuntimeHostStatusSnapshot {
  const bridge = bridges.get(snapshot.environmentId)?.bridge
  const route = bridge ? bridge.activeRoute : 'direct'
  return route ? { ...snapshot, route } : snapshot
}

export function disposeRuntimeEnvironmentRelayBridge(environmentId: string): void {
  const cached = bridges.get(environmentId)
  bridges.delete(environmentId)
  cached?.bridge.dispose()
}

// Why: `orca serve --relay` without --pairing-address advertises loopback, which only an SSH tunnel reaches.
function isDirectEndpointUsable(environment: KnownRuntimeEnvironment, pairing: PairingOffer) {
  try {
    return (
      environment.connectionDependency === 'ssh-tunnel' ||
      classifyRemotePairingHostname(new URL(pairing.endpoint).hostname) !== 'loopback'
    )
  } catch {
    return false
  }
}

function readRelayRoute(userDataPath: string, environmentId: string) {
  try {
    return resolveEnvironment(userDataPath, environmentId).relay ?? null
  } catch {
    return null
  }
}
