import type { RelayPtyOwnershipTransferAdapterState } from './relay-pty-ownership-transfer-adapter-state'
import { matchesRelayPtyOwnershipTransferSourceIncarnation } from './relay-pty-ownership-transfer-source-incarnation'

/** Re-applies durable fences after the current execution provider proves exact liveness. */
export function restoreRelayPtyOwnershipTransferInputFences(
  state: RelayPtyOwnershipTransferAdapterState
): number {
  let restored = 0
  for (const transfer of state.transfers.values()) {
    if (transfer.phase === 'aborted' || transfer.exit) {
      continue
    }
    if (!matchesRelayPtyOwnershipTransferSourceIncarnation(state, transfer)) {
      continue
    }
    state.options.setInputFenced(transfer.identity.terminalId, true)
    restored++
  }
  return restored
}
