import type { RelayPtyOwnershipTransferAdapterState } from './relay-pty-ownership-transfer-adapter-state'
import { removePersistedRelayPtyOwnershipTransfer } from './relay-pty-ownership-transfer-adapter-persistence'

export function removeRelayPtyOwnershipTerminal(
  state: RelayPtyOwnershipTransferAdapterState,
  terminalId: string,
  incarnationId?: string
): void {
  const bridgeId = state.transferByTerminal.get(terminalId)
  if (!bridgeId) {
    return
  }
  const transfer = state.transfers.get(bridgeId)
  if (transfer && incarnationId && transfer.identity.incarnationId !== incarnationId) {
    return
  }
  if (transfer?.exit) {
    return
  }
  state.histories.delete(terminalId)
  if (transfer?.phase === 'prepared') {
    transfer.phase = 'aborted'
    state.options.setInputFenced(terminalId, false)
    state.options.onAborted?.(transfer.identity)
  }
  removePersistedRelayPtyOwnershipTransfer(state, bridgeId)
  state.transfers.delete(bridgeId)
  state.transferByTerminal.delete(terminalId)
}
