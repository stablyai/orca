import { z } from 'zod'
import { salvagedOptional } from '../../../../src/shared/zod-salvage'
import type { RelayHostReachability } from '../../transport/relay-host-reachability'
import type { RpcClient } from '../../transport/rpc-client'
import type { MobileConnectionPath } from '../../transport/stable-logical-rpc-client'
import type { ConnectionState } from '../../transport/types'

export const BRIDGE_CONNECTION_STATES = [
  'connecting',
  'handshaking',
  'connected',
  'disconnected',
  'reconnecting',
  'auth-failed'
] as const

export const BRIDGE_CONNECTION_PATHS = [
  'lan',
  'tailscale',
  'relay'
] as const satisfies readonly MobileConnectionPath[]

export const BRIDGE_RELAY_HOST_REACHABILITIES = [
  'connecting',
  'signed-out',
  'host-offline',
  'credential-refused',
  'unreachable'
] as const satisfies readonly RelayHostReachability[]

// Send whole connection snapshots so lost frames cannot leave partial state; generation detects snapshots that need repair.
export const BridgeConnectionSnapshotSchema = z.object({
  state: z.enum(BRIDGE_CONNECTION_STATES),
  reconnectAttempt: z.number().int().nonnegative(),
  lastConnectedAt: z.number().nullable(),
  lastInboundAt: z.number().nullable(),
  generation: z.number().int().nonnegative().nullable(),
  // Older shells omit these; the page then reads relay with nothing pending, as it did before.
  activePath: salvagedOptional('activePath', z.enum(BRIDGE_CONNECTION_PATHS)),
  pendingPath: salvagedOptional('pendingPath', z.enum(BRIDGE_CONNECTION_PATHS).nullable()),
  relayHostReachability: salvagedOptional(
    'relayHostReachability',
    z.enum(BRIDGE_RELAY_HOST_REACHABILITIES)
  )
})

export type BridgeConnectionSnapshot = z.infer<typeof BridgeConnectionSnapshotSchema>

/** The shell's whole view of its client; `state` is the event's, which a getter can outrun. */
export function readBridgeConnectionSnapshot(
  client: RpcClient,
  state?: ConnectionState
): BridgeConnectionSnapshot {
  return {
    state: state ?? client.getState(),
    reconnectAttempt: client.getReconnectAttempt(),
    lastConnectedAt: client.getLastConnectedAt(),
    lastInboundAt: client.getLastInboundAt?.() ?? null,
    generation: client.getGeneration?.() ?? null,
    activePath: client.getActivePath?.(),
    pendingPath: client.getPendingPath?.(),
    relayHostReachability: client.getRelayHostReachability?.()
  }
}

export type BridgeConnectionPathSource = {
  getActivePath: () => MobileConnectionPath
  getPendingPath: () => MobileConnectionPath | null
  getRelayHostReachability: () => RelayHostReachability
  onConnectionPathChange: (listener: () => void) => () => void
}
