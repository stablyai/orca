import type {
  RelayPtyOwnershipTransferAdapterState,
  RelayPtyOwnershipTransferRecord
} from './relay-pty-ownership-transfer-adapter-state'

/** A prepared delegation binds the original owner; desktop presence is not PTY liveness. */
export function matchesRelayPtyOwnershipTransferSourceIncarnation(
  state: RelayPtyOwnershipTransferAdapterState,
  transfer: RelayPtyOwnershipTransferRecord
): boolean {
  if (transfer.exit) {
    return false
  }
  if (transfer.destinationDelegation && state.options.resolveTerminalIncarnation) {
    return (
      state.options.resolveTerminalIncarnation(transfer.identity.terminalId) ===
      transfer.identity.incarnationId
    )
  }
  const current = state.options.resolveSource(transfer.identity.terminalId)
  return Boolean(
    current &&
    current.terminalId === transfer.identity.terminalId &&
    current.incarnationId === transfer.identity.incarnationId &&
    current.ownerLease === transfer.identity.ownerLease &&
    current.sourceOwnerGeneration === transfer.identity.sourceOwnerGeneration
  )
}
