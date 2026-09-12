import type { RelayPtyOwnershipTransferAdapterState } from './relay-pty-ownership-transfer-adapter-state'
import { observeRelayPtyOwnershipTransferExit } from './relay-pty-ownership-transfer-control'

export function observeRelayPtyOwnershipTransferAdapterExit(
  state: RelayPtyOwnershipTransferAdapterState,
  terminalOrEvent: string | { terminalId: string; incarnationId: string; code?: number },
  incarnationId?: string,
  code?: number
): void {
  if (typeof terminalOrEvent === 'string') {
    observeRelayPtyOwnershipTransferExit(state, terminalOrEvent, incarnationId!, code)
  } else {
    observeRelayPtyOwnershipTransferExit(
      state,
      terminalOrEvent.terminalId,
      terminalOrEvent.incarnationId,
      terminalOrEvent.code
    )
  }
}
