import '../encryption/mobile-relay-e2ee-link'
import '../encryption/mobile-e2ee-v2-physical-channel'
import '../relay/replacement-session-authentication'
import type { RelayReconnectController } from '../relay/mobile-relay-reconnect-controller'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'

// Retire a suspect session after failed replacement or stale connected state blocks the armed recovery retry.
export function suspendRelayIfStillConnected(
  controller: RelayReconnectController,
  logical: StableLogicalRpcClient
): void {
  if (logical.getState() === 'connected') {
    controller.suspendActiveRelay(logical)
  }
}

export function liveRelayLeaseExpiry(
  logical: StableLogicalRpcClient,
  stopped: boolean,
  expiry: number | null
): number | null {
  return !stopped && logical.getActivePath() === 'relay' && logical.getState() === 'connected'
    ? expiry
    : null
}
