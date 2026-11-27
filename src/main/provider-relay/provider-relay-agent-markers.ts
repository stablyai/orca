import type { ProviderRelayWorkMarker } from '../daemon/protocol/daemon-provider-relay-protocol'
import type { ProviderRelayItemContinuation } from './relayed-provider-continuation'
import type { ProviderRelayAckFloor } from './relayed-provider-output'

/**
 * What the open app's idle stop counts, as the daemon can see it: agent lines that open and close
 * turns and background tasks, and the app's own requests that are work until answered.
 */
export type ProviderRelayWorkMarkers = {
  /** The agent integration, recorded with each relay; register it as reattachable. */
  agent: string
  markers: readonly ProviderRelayWorkMarker[]
  /** A fresh tracker per attach, so acks never pass the start of a streamed item still open. */
  ackFloor?: () => ProviderRelayAckFloor
  /** How the provider moves an item a cap-cut replay starts inside to a continuation row. */
  continuation?: ProviderRelayItemContinuation
  requests?: readonly string[]
  /** Transport-only lines (a keep-alive) by top-level name; the daemon drops them. */
  quiet?: readonly string[]
  /** Request methods asking to start an item, which isn't running until answered. */
  startApprovals?: readonly string[]
}
