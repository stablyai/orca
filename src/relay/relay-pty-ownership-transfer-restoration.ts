import { MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS } from '../shared/pty-ownership-transfer-journal-contract'
import { invalidJournal } from './relay-pty-ownership-transfer-journal-record-validation'
import type {
  RelayPtyOwnershipTransferAdapterState,
  RelayPtyOwnershipTransferOutputHistory,
  RelayPtyOwnershipTransferRecord
} from './relay-pty-ownership-transfer-adapter-state'

export function restoreRelayPtyOwnershipTransferRecords(
  state: RelayPtyOwnershipTransferAdapterState,
  parse: (
    value: unknown,
    replayBytes: number,
    inputIds: number
  ) => Readonly<{
    transfer: RelayPtyOwnershipTransferRecord
    history: RelayPtyOwnershipTransferOutputHistory
  }>
): void {
  const records = state.options.store?.loadAll() ?? []
  if (records.length > MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS) {
    throw invalidJournal()
  }
  for (const value of records) {
    const restored = parse(value, state.replayBytes, state.inputIds)
    const bridgeId = restored.transfer.identity.bridgeId
    const terminalId = restored.transfer.identity.terminalId
    if (state.transfers.has(bridgeId) || state.transferByTerminal.has(terminalId)) {
      throw invalidJournal()
    }
    state.transfers.set(bridgeId, restored.transfer)
    state.transferByTerminal.set(terminalId, bridgeId)
    state.histories.set(terminalId, restored.history)
  }
  for (const transfer of state.transfers.values()) {
    if (transfer.phase !== 'aborted') {
      // A relay may restore its journal before PTY revive; defer fencing until the source exists.
      const source = state.options.resolveSource(transfer.identity.terminalId)
      if (source?.incarnationId === transfer.identity.incarnationId) {
        state.options.setInputFenced(transfer.identity.terminalId, true)
      }
    }
  }
}
