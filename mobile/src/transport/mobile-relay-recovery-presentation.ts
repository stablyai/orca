import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import type { RelayReconnectController } from './mobile-relay-reconnect-controller'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ConnectionState } from './types'

export function onActiveFailure(
  logical: StableLogicalRpcClient,
  controller: RelayReconnectController,
  state: ConnectionState,
  bundle: MobileRelayCredentialBundle | null
): void {
  if (
    controller.needsRecovery(state) &&
    logical.getActivePath() === 'relay' &&
    bundle &&
    controller.hasDialableCredential(bundle.current, bundle.grace)
  ) {
    logical.setRecoveryPath('relay')
  }
}

export function clearIfCredentialBlocked(
  logical: StableLogicalRpcClient,
  controller: RelayReconnectController
): void {
  if (controller.blocksUntilFreshCredential()) {
    logical.setRecoveryPath(null)
  }
}
