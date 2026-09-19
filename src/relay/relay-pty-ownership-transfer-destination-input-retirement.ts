import { parsePtyOwnershipTransferDestinationRetireInputRequest } from '../shared/pty-ownership-transfer-destination-input'
import type { RequestContext } from './dispatcher'
import type { RelayPtyOwnershipTransferAdapterState } from './relay-pty-ownership-transfer-adapter-state'
import {
  requireDestinationProof,
  isRelayPtyOwnershipTransferDestinationClaimActive
} from './relay-pty-ownership-transfer-destination-claim'
import { persistRelayPtyOwnershipTransfer } from './relay-pty-ownership-transfer-adapter-persistence'

export function retireRelayPtyOwnershipTransferDestinationInput(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown,
  context: RequestContext
) {
  const request = parsePtyOwnershipTransferDestinationRetireInputRequest(value)
  const { transfer } = requireDestinationProof(state, request, context)
  if (
    !state.options.enableDestinationDelegationInput ||
    !transfer.destinationInputJournal ||
    transfer.phase !== 'committed' ||
    !isRelayPtyOwnershipTransferDestinationClaimActive(
      state,
      request,
      request.destinationClaim,
      context
    )
  ) {
    throw new Error('pty_ownership_transfer_destination_input_retirement_unavailable')
  }
  const epoch = transfer.destinationInputEpoch ?? 0
  if (request.inputEpoch !== epoch) {
    throw new Error('pty_ownership_transfer_destination_input_epoch_stale')
  }
  const entries = transfer.destinationInputs!
  if (
    request.inputIds.length === 0 ||
    request.inputIds.length !== entries.size ||
    request.inputIds.some((id) => entries.get(id)?.outcome !== 'applied')
  ) {
    throw new Error('pty_ownership_transfer_destination_input_retirement_unacknowledged')
  }
  // The durable epoch rejects every late retry even after its payload has been removed.
  transfer.destinationInputEpoch = epoch + 1
  transfer.destinationInputs = new Map()
  try {
    persistRelayPtyOwnershipTransfer(state, transfer)
  } catch (error) {
    transfer.destinationDelegationWriteUnverifiable = true
    transfer.destinationClaimBinding = undefined
    transfer.destinationOutputRoute?.dispose()
    transfer.destinationOutputRoute = undefined
    throw error
  }
  return Object.freeze({
    ...transfer.identity,
    version: 1 as const,
    inputEpoch: transfer.destinationInputEpoch,
    retired: request.inputIds.length
  })
}
