import { parsePtyOwnershipTransferDestinationControlRequest } from '../shared/pty-ownership-transfer-destination-control'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_DURABLE_INPUT_BYTES } from '../shared/pty-ownership-transfer-destination-input'
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

export async function applyRelayPtyOwnershipTransferDelegatedControl(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown,
  context: RequestContext
) {
  const request = parsePtyOwnershipTransferDestinationControlRequest(value)
  const { transfer } = requireDestinationProof(state, request, context)
  const active = () =>
    isRelayPtyOwnershipTransferDestinationClaimActive(
      state,
      request,
      request.destinationClaim,
      context
    )
  if (
    !state.options.enableDestinationDelegationControl ||
    !transfer.destinationOutputRetention ||
    transfer.phase !== 'committed' ||
    !transfer.commitReceipt ||
    !active()
  ) {
    throw new Error('pty_ownership_transfer_destination_control_unavailable')
  }
  const result = (outcome: 'applied' | 'unverifiable', duplicate: boolean) =>
    Object.freeze({
      ...transfer.identity,
      version: 1 as const,
      controlId: request.controlId,
      outcome,
      duplicate
    })
  const serializedControl = JSON.stringify(request.control)
  const previous = transfer.destinationControls?.get(request.controlId)
  if (previous) {
    if (previous.serializedControl !== serializedControl) {
      throw new Error('pty_ownership_transfer_destination_control_conflict')
    }
    return result(previous.outcome, true)
  }
  const isAuthorized = () =>
    active() && relayPtyOwnershipTransferExecutionVerdict(state, transfer) === 'live'
  if (!state.options.applyDestinationControl || !isAuthorized()) {
    throw new Error('pty_ownership_transfer_destination_control_execution_unverifiable')
  }
  const entries = transfer.destinationControls ?? new Map()
  let bytes =
    Buffer.byteLength(request.controlId, 'utf8') + Buffer.byteLength(serializedControl, 'utf8')
  for (const [id, entry] of entries) {
    bytes += Buffer.byteLength(id, 'utf8') + Buffer.byteLength(entry.serializedControl, 'utf8')
  }
  if (
    entries.size >= state.inputIds ||
    bytes > PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_DURABLE_INPUT_BYTES
  ) {
    throw new Error('pty_ownership_transfer_destination_control_capacity')
  }
  const entry = { serializedControl, outcome: 'unverifiable' as 'applied' | 'unverifiable' }
  entries.set(request.controlId, entry)
  transfer.destinationControls = entries
  transfer.destinationControlJournal = true
  transfer.destinationInputJournal = true
  transfer.destinationInputs ??= new Map()
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
  persist()
  if (!isAuthorized()) {
    return result('unverifiable', false)
  }
  try {
    const outcome = await state.options.applyDestinationControl(
      transfer.identity,
      request.control,
      isAuthorized
    )
    entry.outcome = outcome === 'applied' ? 'applied' : 'unverifiable'
  } catch {
    // A rejected host operation may already have delivered its signal.
  }
  persist()
  return result(entry.outcome, false)
}
