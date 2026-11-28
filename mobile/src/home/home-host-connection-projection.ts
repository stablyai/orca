import type { Translate } from '../i18n/mobile-i18n'
import type { RelayHostReachability } from '../transport/relay/relay-host-reachability'
import type { MobileConnectionPath } from '../transport/connection/stable-logical-rpc-client'
import {
  classifyConnection,
  isConnectionDialing,
  type ConnectionVerdict
} from '../transport/connection/connection-health'
import type { ConnectionState } from '../transport/connection/connection-state'
import { resolveHomeHostConnectionState } from '../transport/hosts/home-host-auto-connect'

export type HomeHostConnectionProjectionEntry = {
  hostId: string
  path: MobileConnectionPath
  pendingPath: MobileConnectionPath | null
  pairingRejected: boolean
  relayHostReachability: RelayHostReachability
}

export type HomeHostConnections = Record<string, HomeHostConnectionProjectionEntry>

export function projectHomeHostConnections(
  entries: readonly HomeHostConnectionProjectionEntry[]
): HomeHostConnections {
  // Why: a host named `__proto__` must land as an own key, not mutate the prototype.
  const byHostId: HomeHostConnections = Object.create(null)
  for (const entry of entries) {
    byHostId[entry.hostId] = entry
  }
  Object.setPrototypeOf(byHostId, Object.prototype)
  return byHostId
}

export type HomeHostConnectionInputs = {
  autoConnectHostIds: readonly string[]
  hostAttempts: Readonly<Record<string, number>>
  hostConnections: HomeHostConnections
  hostLastConnected: Readonly<Record<string, number | null>>
  hostStates: Readonly<Record<string, ConnectionState>>
}

/** A paired desktop's connection as its Home row shows it. */
export function classifyHomeHostConnection(
  host: { id: string; name: string; endpoint: string },
  inputs: HomeHostConnectionInputs,
  t: Translate,
  nowMs?: number
): { state: ConnectionState; verdict: ConnectionVerdict } {
  const state = resolveHomeHostConnectionState(
    host.id,
    inputs.hostStates[host.id],
    inputs.autoConnectHostIds
  )
  const connection = inputs.hostConnections[host.id]
  const verdict = classifyConnection(
    {
      state,
      reconnectAttempts: inputs.hostAttempts[host.id] ?? 0,
      lastConnectedAt: inputs.hostLastConnected[host.id] ?? null,
      endpoint: host.endpoint,
      pendingPath: connection?.pendingPath ?? null,
      pairingRejected: connection?.pairingRejected ?? false,
      relayHostReachability: connection?.relayHostReachability ?? 'connecting',
      hostName: host.name,
      nowMs
    },
    t
  )
  return { state, verdict }
}

/** Paired desktops that answer nothing until something changes: not connected and not dialing, as
 *  their Home rows say (Disconnected, Can't connect, Can't reach, re-pair). */
export function homeUnreachableHostIds(
  hosts: readonly { id: string; name: string; endpoint: string }[],
  inputs: HomeHostConnectionInputs,
  nowMs: number,
  t: Translate
): string[] {
  return hosts.flatMap((host) => {
    const { state, verdict } = classifyHomeHostConnection(host, inputs, t, nowMs)
    return state !== 'connected' && !isConnectionDialing(verdict) ? [host.id] : []
  })
}
