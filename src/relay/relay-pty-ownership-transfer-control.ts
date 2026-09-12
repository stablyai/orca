import {
  parsePtyOwnershipTransferAttachmentRequest,
  parsePtyOwnershipTransferControlRequest,
  type PtyOwnershipTransferAttachmentResult,
  type PtyOwnershipTransferControlResult,
  type PtyOwnershipTransferExitEvent
} from '../shared/pty-ownership-transfer-control-wire'
import { PTY_OWNERSHIP_TRANSFER_WIRE_VERSION } from '../shared/pty-ownership-transfer-wire'
import { persistRelayPtyOwnershipTransfer } from './relay-pty-ownership-transfer-adapter-persistence'
import {
  relayPtyOwnershipTransferExecutionVerdict,
  requireRelayPtyOwnershipTransfer,
  type RelayPtyOwnershipTransferAdapterState,
  type RelayPtyOwnershipTransferRecord,
  type RelayPtyOwnershipTransferAttachmentBinding
} from './relay-pty-ownership-transfer-adapter-state'
import { RelayPtyOwnershipTransferError } from './relay-pty-ownership-transfer-errors'
import { assertRelayPtyOwnershipTransferLegacyDestination } from './relay-pty-ownership-transfer-source-route-authorization'

export function attachRelayPtyOwnershipTransferDestination(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown,
  binding?: RelayPtyOwnershipTransferAttachmentBinding
): PtyOwnershipTransferAttachmentResult {
  const request = parsePtyOwnershipTransferAttachmentRequest(value)
  const transfer = requireRelayPtyOwnershipTransfer(state, request)
  assertRelayPtyOwnershipTransferLegacyDestination(transfer)
  if (transfer.phase === 'aborted') {
    throw new RelayPtyOwnershipTransferError(
      'invalid-phase',
      'an aborted ownership transfer cannot attach a destination'
    )
  }
  const initialRoute = Object.freeze({
    generation: transfer.identity.sourceOwnerGeneration,
    attachmentId: request.attachmentId
  })
  const existingRoute = transfer.reconnectRoute
  if (
    existingRoute &&
    (existingRoute.generation !== initialRoute.generation ||
      existingRoute.attachmentId !== initialRoute.attachmentId)
  ) {
    throw new RelayPtyOwnershipTransferError(
      'reconnect-rekey-required',
      'a newer owner must atomically rekey the durable destination route'
    )
  }
  const previousAttachmentId = transfer.attachmentId
  const previousAttachmentBinding = transfer.attachmentBinding
  if (!existingRoute) {
    transfer.reconnectRoute = initialRoute
  }
  transfer.attachmentId = request.attachmentId
  if (binding) {
    transfer.attachmentBinding = Object.freeze({ ...binding })
  }
  if (!existingRoute) {
    try {
      persistRelayPtyOwnershipTransfer(state, transfer)
    } catch (error) {
      transfer.reconnectRoute = undefined
      transfer.attachmentId = previousAttachmentId
      transfer.attachmentBinding = previousAttachmentBinding
      throw error
    }
  }
  const executionVerdict = relayPtyOwnershipTransferExecutionVerdict(state, transfer)
  return Object.freeze({
    ...transfer.identity,
    version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
    phase: transfer.phase,
    attachmentId: request.attachmentId,
    executionVerdict,
    ...(transfer.exit ? { exit: structuredClone(transfer.exit) } : {})
  })
}

export async function controlRelayPtyOwnershipTransferDestination(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown,
  binding?: RelayPtyOwnershipTransferAttachmentBinding
): Promise<PtyOwnershipTransferControlResult> {
  const request = parsePtyOwnershipTransferControlRequest(value)
  const transfer = requireRelayPtyOwnershipTransfer(state, request)
  assertRelayPtyOwnershipTransferLegacyDestination(transfer)
  requireAttachedLiveDestination(state, transfer, request.attachmentId, binding)
  if (transfer.acceptedControls.size >= state.inputIds) {
    throw new RelayPtyOwnershipTransferError(
      'control-deduplication-window-exhausted',
      'control deduplication window is full'
    )
  }
  const serializedControl = JSON.stringify(request.control)
  const previous = transfer.acceptedControls.get(request.controlId)
  if (previous) {
    if (previous.serializedControl !== serializedControl) {
      throw new RelayPtyOwnershipTransferError(
        'control-conflict',
        `control ID ${request.controlId} changed`
      )
    }
    return controlResult(transfer, request.attachmentId, request.controlId, previous.outcome, true)
  }
  // Why: reserve before the host mutation so a lost response cannot replay a signal or shutdown.
  transfer.acceptedControls.set(request.controlId, {
    serializedControl,
    outcome: 'unverifiable'
  })
  persistRelayPtyOwnershipTransfer(state, transfer)
  let outcome: PtyOwnershipTransferControlResult['outcome'] = 'unverifiable'
  try {
    outcome = state.options.applyDestinationControl
      ? await state.options.applyDestinationControl(transfer.identity, request.control, () => {
          try {
            requireAttachedLiveDestination(state, transfer, request.attachmentId, binding)
            return true
          } catch {
            return false
          }
        })
      : 'unverifiable'
  } catch {
    // The owning host cannot safely infer whether a fallible process mutation landed.
  }
  transfer.acceptedControls.set(request.controlId, { serializedControl, outcome })
  persistRelayPtyOwnershipTransfer(state, transfer)
  return controlResult(transfer, request.attachmentId, request.controlId, outcome, false)
}

export function observeRelayPtyOwnershipTransferExit(
  state: RelayPtyOwnershipTransferAdapterState,
  terminalId: string,
  incarnationId: string,
  code?: number
): void {
  const bridgeId = state.transferByTerminal.get(terminalId)
  const transfer = bridgeId ? state.transfers.get(bridgeId) : undefined
  if (
    !transfer ||
    transfer.identity.incarnationId !== incarnationId ||
    (transfer.exit && !transfer.exitObservationPending)
  ) {
    return
  }
  transfer.exitObservationPending = true
  transfer.exit ??= Object.freeze({
    verdict: 'exited',
    eventId: state.options.createExitEventId?.() ?? `${transfer.identity.bridgeId}:exit`,
    observedAt: (state.options.now?.() ?? new Date()).toISOString(),
    ...(code === undefined ? {} : { code })
  })
  persistRelayPtyOwnershipTransfer(state, transfer)
  if (!transfer.attachmentId) {
    transfer.exitObservationPending = false
    state.wakeDestinationOutput?.()
    return
  }
  const event: PtyOwnershipTransferExitEvent = Object.freeze({
    ...transfer.identity,
    version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
    attachmentId: transfer.attachmentId,
    exit: structuredClone(transfer.exit)
  })
  state.options.publishDestinationExit?.(event, transfer.attachmentBinding)
  transfer.exitObservationPending = false
  state.wakeDestinationOutput?.()
}

export function requireAttachedLiveDestination(
  state: RelayPtyOwnershipTransferAdapterState,
  transfer: RelayPtyOwnershipTransferRecord,
  attachmentId: string,
  binding?: RelayPtyOwnershipTransferAttachmentBinding
): void {
  if (transfer.phase !== 'committed' && transfer.phase !== 'published') {
    throw new RelayPtyOwnershipTransferError(
      'invalid-phase',
      'destination controls are unavailable before commit'
    )
  }
  if (transfer.attachmentId !== attachmentId) {
    throw new RelayPtyOwnershipTransferError(
      'stale-attachment',
      'destination control does not match the current attachment'
    )
  }
  const expectedBinding = transfer.attachmentBinding
  if (
    expectedBinding &&
    (!binding ||
      expectedBinding.clientId !== binding.clientId ||
      (expectedBinding.transportGeneration !== undefined &&
        expectedBinding.transportGeneration !== binding.transportGeneration))
  ) {
    throw new RelayPtyOwnershipTransferError(
      'stale-attachment',
      'destination control does not match the attached relay client generation'
    )
  }
  if (relayPtyOwnershipTransferExecutionVerdict(state, transfer) !== 'live') {
    throw new RelayPtyOwnershipTransferError(
      'execution-unverifiable',
      'the execution owner cannot prove this PTY is live'
    )
  }
}

function controlResult(
  transfer: RelayPtyOwnershipTransferRecord,
  attachmentId: string,
  controlId: string,
  outcome: PtyOwnershipTransferControlResult['outcome'],
  duplicate: boolean
): PtyOwnershipTransferControlResult {
  return Object.freeze({
    ...transfer.identity,
    version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
    attachmentId,
    controlId,
    outcome,
    duplicate
  })
}
