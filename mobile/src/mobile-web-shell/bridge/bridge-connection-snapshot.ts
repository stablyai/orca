import { z } from 'zod'
import type { RpcClient } from '../../transport/rpc-client'
import type { ConnectionState } from '../../transport/types'

export const BRIDGE_CONNECTION_STATES = [
  'connecting',
  'handshaking',
  'connected',
  'disconnected',
  'reconnecting',
  'auth-failed'
] as const

// Send whole connection snapshots so lost frames cannot leave partial state; generation detects snapshots that need repair.
export const BridgeConnectionSnapshotSchema = z.object({
  state: z.enum(BRIDGE_CONNECTION_STATES),
  reconnectAttempt: z.number().int().nonnegative(),
  lastConnectedAt: z.number().nullable(),
  lastInboundAt: z.number().nullable(),
  generation: z.number().int().nonnegative().nullable()
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
    generation: client.getGeneration?.() ?? null
  }
}
