import {
  parsePtyOwnershipTransferPrepareRequest,
  PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
  type PtyOwnershipTransferPrepareRequest,
  type PtyOwnershipTransferPrepareResult
} from '../shared/pty-ownership-transfer-wire'
import { MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS } from '../shared/pty-ownership-transfer-journal-contract'
import { samePtyOwnershipTransferSurfaceBinding } from '../shared/pty-ownership-transfer-surface-binding'
import { RelayPtyOwnershipTransferError } from './relay-pty-ownership-transfer-errors'
import {
  assertRelayPtyOwnershipTransferIdentity,
  emptyRelayPtyOwnershipTransferHistory,
  type RelayPtyOwnershipTransferAdapterState,
  type RelayPtyOwnershipTransferRecord
} from './relay-pty-ownership-transfer-adapter-state'
import { persistRelayPtyOwnershipTransfer } from './relay-pty-ownership-transfer-adapter-persistence'

export function prepareRelayPtyOwnershipTransfer(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown
): PtyOwnershipTransferPrepareResult {
  const request = parsePtyOwnershipTransferPrepareRequest(value)
  if (
    request.destinationDelegation &&
    (!state.options.enableDestinationDelegationPreparation || !state.options.store)
  ) {
    throw new Error('pty_ownership_transfer_destination_delegation_unavailable')
  }
  const existing = state.transfers.get(request.bridgeId)
  if (existing) {
    assertRelayPtyOwnershipTransferIdentity(existing, request)
    assertSurfacePublicationNegotiation(existing, request)
    if (
      existing.destinationDelegation?.credentialSha256 !==
      request.destinationDelegation?.credentialSha256
    ) {
      throw new RelayPtyOwnershipTransferError(
        'identity-mismatch',
        'destination delegation cannot be changed on retry'
      )
    }
    if (existing.phase === 'aborted') {
      throw new RelayPtyOwnershipTransferError(
        'invalid-phase',
        'an aborted ownership transfer cannot be reused'
      )
    }
    if (existing.destinationDelegationWriteUnverifiable) {
      throw new Error('pty_ownership_transfer_delegation_write_unverifiable')
    }
    if (existing.destinationDelegation) {
      try {
        persistRelayPtyOwnershipTransfer(state, existing)
      } catch (error) {
        existing.destinationDelegationWriteUnverifiable = true
        throw error
      }
    }
    return prepareRelayPtyOwnershipTransferResult(existing)
  }
  if (state.transferByTerminal.has(request.terminalId)) {
    throw new RelayPtyOwnershipTransferError(
      'already-transferring',
      'the PTY already has an ownership transfer in progress'
    )
  }
  if (state.transfers.size >= MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS) {
    throw new RelayPtyOwnershipTransferError(
      'already-transferring',
      'relay ownership transfer capacity is exhausted'
    )
  }
  const source = state.options.resolveSource(request.terminalId)
  if (
    !source ||
    source.terminalId !== request.terminalId ||
    source.incarnationId !== request.incarnationId ||
    source.ownerLease !== request.ownerLease ||
    source.sourceOwnerGeneration !== request.sourceOwnerGeneration
  ) {
    throw new RelayPtyOwnershipTransferError(
      source ? 'identity-mismatch' : 'not-found',
      source
        ? 'ownership transfer identity does not match the live source PTY'
        : 'source PTY is not available'
    )
  }
  const history = state.histories.get(request.terminalId) ?? emptyRelayPtyOwnershipTransferHistory()
  const transfer: RelayPtyOwnershipTransferRecord = {
    identity: Object.freeze(identityFromPrepareRequest(request)),
    ...(request.destinationDelegation
      ? { destinationDelegation: request.destinationDelegation }
      : {}),
    phase: 'prepared',
    ...(request.destinationDelegation && state.options.enableDestinationOutputRetention
      ? {
          destinationOutputRetention: true as const,
          destinationAcknowledgedSeq: (history.frames[0]?.seq ?? history.nextSeq) - 1
        }
      : {}),
    sourceOutputEndSeq: history.nextSeq - 1,
    replayStartSeq: history.frames[0]?.seq ?? history.nextSeq,
    ...(request.surfacePublication
      ? { surfacePublication: Object.freeze({ ...request.surfacePublication }) }
      : {}),
    acceptedInputIds: new Map(),
    acceptedControls: new Map(),
    observedEmissions: new Map()
  }
  const hadHistory = state.histories.has(request.terminalId)
  state.options.setInputFenced(request.terminalId, true)
  state.histories.set(request.terminalId, history)
  state.transfers.set(request.bridgeId, transfer)
  state.transferByTerminal.set(request.terminalId, request.bridgeId)
  try {
    persistRelayPtyOwnershipTransfer(state, transfer)
  } catch (error) {
    if (transfer.destinationDelegation) {
      // A failed fsync may follow a successful rename; retain the source fence until recovery.
      transfer.destinationDelegationWriteUnverifiable = true
      throw error
    }
    state.transfers.delete(request.bridgeId)
    state.transferByTerminal.delete(request.terminalId)
    if (!hadHistory) {
      state.histories.delete(request.terminalId)
    }
    state.options.setInputFenced(request.terminalId, false)
    throw error
  }
  return prepareRelayPtyOwnershipTransferResult(transfer)
}

function prepareRelayPtyOwnershipTransferResult(
  transfer: RelayPtyOwnershipTransferRecord
): PtyOwnershipTransferPrepareResult {
  return Object.freeze({
    ...transfer.identity,
    version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
    phase: 'prepared',
    sourceOutputEndSeq: transfer.sourceOutputEndSeq,
    replayStartSeq: transfer.replayStartSeq,
    ...(transfer.destinationDelegation
      ? { destinationDelegation: transfer.destinationDelegation }
      : {}),
    ...(transfer.surfacePublication
      ? { surfacePublication: Object.freeze({ ...transfer.surfacePublication }) }
      : {})
  })
}

function assertSurfacePublicationNegotiation(
  transfer: RelayPtyOwnershipTransferRecord,
  request: PtyOwnershipTransferPrepareRequest
): void {
  const expected = transfer.surfacePublication
  const actual = request.surfacePublication
  if (
    expected?.version !== actual?.version ||
    !samePtyOwnershipTransferSurfaceBinding(expected?.surfaceBinding, actual?.surfaceBinding)
  ) {
    throw new RelayPtyOwnershipTransferError(
      'identity-mismatch',
      'ownership transfer surface-publication negotiation changed'
    )
  }
}

function identityFromPrepareRequest(
  request: PtyOwnershipTransferPrepareRequest
): RelayPtyOwnershipTransferRecord['identity'] {
  return {
    bridgeId: request.bridgeId,
    terminalId: request.terminalId,
    incarnationId: request.incarnationId,
    ownerLease: request.ownerLease,
    sourceOwnerGeneration: request.sourceOwnerGeneration,
    destinationRuntimeId: request.destinationRuntimeId
  }
}
