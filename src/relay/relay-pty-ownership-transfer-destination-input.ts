import {
  parsePtyOwnershipTransferDestinationInputRequest,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_DURABLE_INPUT_BYTES
} from '../shared/pty-ownership-transfer-destination-input'
import type { RequestContext } from './dispatcher'
import {
  relayPtyOwnershipTransferExecutionVerdict,
  type RelayPtyOwnershipTransferAdapterState
} from './relay-pty-ownership-transfer-adapter-state'
import {
  requireDestinationProof,
  isRelayPtyOwnershipTransferDestinationClaimActive
} from './relay-pty-ownership-transfer-destination-claim'
import { persistRelayPtyOwnershipTransfer } from './relay-pty-ownership-transfer-adapter-persistence'

export function acceptRelayPtyOwnershipTransferDestinationInput(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown,
  context: RequestContext
) {
  const request = parsePtyOwnershipTransferDestinationInputRequest(value)
  const { transfer } = requireDestinationProof(state, request, context)
  const active = () =>
    isRelayPtyOwnershipTransferDestinationClaimActive(
      state,
      request,
      request.destinationClaim,
      context
    )
  if (
    !state.options.enableDestinationDelegationInput ||
    !transfer.destinationOutputRetention ||
    transfer.phase !== 'committed' ||
    !transfer.commitReceipt ||
    !active()
  ) {
    throw new Error('pty_ownership_transfer_destination_input_unavailable')
  }
  const result = (outcome: 'applied' | 'unverifiable', duplicate: boolean) =>
    Object.freeze({
      ...transfer.identity,
      version: 1 as const,
      inputId: request.inputId,
      inputEpoch: request.inputEpoch,
      outcome,
      duplicate
    })
  if (request.inputEpoch !== (transfer.destinationInputEpoch ?? 0)) {
    throw new Error('pty_ownership_transfer_destination_input_epoch_stale')
  }
  const previous = transfer.destinationInputs?.get(request.inputId)
  if (previous) {
    if (previous.data !== request.data) {
      throw new Error('pty_ownership_transfer_destination_input_conflict')
    }
    return result(previous.outcome, true)
  }
  if (relayPtyOwnershipTransferExecutionVerdict(state, transfer) !== 'live') {
    throw new Error('pty_ownership_transfer_destination_input_execution_unverifiable')
  }
  const entries = transfer.destinationInputs ?? new Map()
  let bytes = Buffer.byteLength(request.inputId, 'utf8') + Buffer.byteLength(request.data, 'utf8')
  for (const [id, entry] of entries) {
    bytes += Buffer.byteLength(id, 'utf8') + Buffer.byteLength(entry.data, 'utf8')
  }
  if (
    entries.size >= state.inputIds ||
    bytes > PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_DURABLE_INPUT_BYTES
  ) {
    throw new Error('pty_ownership_transfer_destination_input_capacity')
  }
  const entry = { data: request.data, outcome: 'unverifiable' as 'applied' | 'unverifiable' }
  entries.set(request.inputId, entry)
  transfer.destinationInputs = entries
  transfer.destinationInputJournal = true
  const persist = () => {
    try {
      persistRelayPtyOwnershipTransfer(state, transfer)
    } catch (error) {
      entry.outcome = 'unverifiable'
      transfer.destinationDelegationWriteUnverifiable = true
      transfer.destinationClaimBinding = undefined
      transfer.destinationOutputRoute?.dispose()
      transfer.destinationOutputRoute = undefined
      throw error
    }
  }
  // A durable attempted ID prevents automatic command replay after an ambiguous PTY write.
  persist()
  if (!active() || relayPtyOwnershipTransferExecutionVerdict(state, transfer) !== 'live') {
    return result('unverifiable', false)
  }
  try {
    state.options.writeDestinationInput(request.terminalId, request.data)
  } catch {
    return result('unverifiable', false)
  }
  entry.outcome = 'applied'
  persist()
  return result('applied', false)
}
