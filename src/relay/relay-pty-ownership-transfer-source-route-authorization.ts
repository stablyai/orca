import {
  parsePtyOwnershipTransferWireIdentity,
  PTY_OWNERSHIP_TRANSFER_METHODS
} from '../shared/pty-ownership-transfer-wire'
import {
  requireRelayPtyOwnershipTransfer,
  type RelayPtyOwnershipTransferAdapterState,
  type RelayPtyOwnershipTransferRecord
} from './relay-pty-ownership-transfer-adapter-state'

const destinationMutationMethods = new Set<string>([
  PTY_OWNERSHIP_TRANSFER_METHODS.commit,
  PTY_OWNERSHIP_TRANSFER_METHODS.publish,
  PTY_OWNERSHIP_TRANSFER_METHODS.input,
  PTY_OWNERSHIP_TRANSFER_METHODS.retireInput,
  PTY_OWNERSHIP_TRANSFER_METHODS.attach,
  PTY_OWNERSHIP_TRANSFER_METHODS.rekeyReconnect,
  PTY_OWNERSHIP_TRANSFER_METHODS.control
])

/** Source-owner authorization cannot substitute for a delegated destination claim. */
export function assertRelayPtyOwnershipTransferSourceRoute(
  state: RelayPtyOwnershipTransferAdapterState,
  method: string,
  params: Record<string, unknown>
): void {
  if (!destinationMutationMethods.has(method)) {
    return
  }
  const identity = parsePtyOwnershipTransferWireIdentity(params)
  const transfer = requireRelayPtyOwnershipTransfer(state, identity)
  assertRelayPtyOwnershipTransferLegacyDestination(transfer)
}

export function assertRelayPtyOwnershipTransferLegacyDestination(
  transfer: RelayPtyOwnershipTransferRecord
): void {
  if (transfer.destinationDelegation) {
    throw new Error('pty_ownership_transfer_delegated_destination_route_required')
  }
}
