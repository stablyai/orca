import {
  parsePtyOwnershipTransferAbortRequest,
  parsePtyOwnershipTransferInputRequest,
  parsePtyOwnershipTransferRetireInputRequest,
  parsePtyOwnershipTransferStatusRequest,
  PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
  type PtyOwnershipTransferInputResult,
  type PtyOwnershipTransferRetireInputResult,
  type PtyOwnershipTransferWireIdentity,
  type PtyOwnershipTransferStatusResult
} from '../shared/pty-ownership-transfer-wire'
import { RelayPtyOwnershipTransferError } from './relay-pty-ownership-transfer-errors'
import {
  requireRelayPtyOwnershipTransfer,
  type RelayPtyOwnershipTransferAdapterState
} from './relay-pty-ownership-transfer-adapter-state'
import { persistRelayPtyOwnershipTransfer } from './relay-pty-ownership-transfer-adapter-persistence'
import { assertRelayPtyOwnershipTransferLegacyDestination } from './relay-pty-ownership-transfer-source-route-authorization'

export function acceptRelayPtyOwnershipTransferInput(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown
): PtyOwnershipTransferInputResult {
  const request = parsePtyOwnershipTransferInputRequest(value)
  const transfer = requireRelayPtyOwnershipTransfer(state, request)
  assertRelayPtyOwnershipTransferLegacyDestination(transfer)
  if (transfer.phase !== 'committed' && transfer.phase !== 'published') {
    throw new RelayPtyOwnershipTransferError(
      'invalid-phase',
      'destination input is unavailable before commit'
    )
  }
  const previous = transfer.acceptedInputIds.get(request.inputId)
  if (previous !== undefined) {
    if (previous !== request.data) {
      throw new RelayPtyOwnershipTransferError(
        'input-conflict',
        `input ID ${request.inputId} changed`
      )
    }
    return { accepted: false, duplicate: true }
  }
  if (transfer.acceptedInputIds.size >= state.inputIds) {
    throw new RelayPtyOwnershipTransferError(
      'input-deduplication-window-exhausted',
      'input deduplication window is full; retire acknowledged IDs before continuing'
    )
  }
  transfer.acceptedInputIds.set(request.inputId, request.data)
  try {
    persistRelayPtyOwnershipTransfer(state, transfer)
  } catch (error) {
    transfer.acceptedInputIds.delete(request.inputId)
    throw error
  }
  // Why: once the write begins its outcome can be ambiguous, so retain the durable ID on failure.
  state.options.writeDestinationInput(request.terminalId, request.data)
  return { accepted: true, duplicate: false }
}

export function retireRelayPtyOwnershipTransferInput(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown
): PtyOwnershipTransferRetireInputResult {
  const request = parsePtyOwnershipTransferRetireInputRequest(value)
  const transfer = requireRelayPtyOwnershipTransfer(state, request)
  assertRelayPtyOwnershipTransferLegacyDestination(transfer)
  if (transfer.phase !== 'committed' && transfer.phase !== 'published') {
    throw new RelayPtyOwnershipTransferError(
      'invalid-phase',
      'input IDs can only be retired after commit'
    )
  }
  let retired = 0
  const retiredEntries: [string, string][] = []
  for (const inputId of request.inputIds) {
    const data = transfer.acceptedInputIds.get(inputId)
    if (data !== undefined && transfer.acceptedInputIds.delete(inputId)) {
      retired++
      retiredEntries.push([inputId, data])
    }
  }
  try {
    persistRelayPtyOwnershipTransfer(state, transfer)
  } catch (error) {
    for (const [inputId, data] of retiredEntries) {
      transfer.acceptedInputIds.set(inputId, data)
    }
    throw error
  }
  return { retired }
}

export function abortRelayPtyOwnershipTransfer(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown
): Readonly<{ version: typeof PTY_OWNERSHIP_TRANSFER_WIRE_VERSION; phase: 'aborted' }> {
  const request = parsePtyOwnershipTransferAbortRequest(value)
  const transfer = requireRelayPtyOwnershipTransfer(state, request)
  if (transfer.phase === 'aborted') {
    return { version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION, phase: 'aborted' }
  }
  if (transfer.phase !== 'prepared') {
    throw new RelayPtyOwnershipTransferError(
      'invalid-phase',
      `cannot abort transfer in ${transfer.phase}`
    )
  }
  transfer.phase = 'aborted'
  try {
    persistRelayPtyOwnershipTransfer(state, transfer)
  } catch (error) {
    transfer.phase = 'prepared'
    throw error
  }
  state.options.setInputFenced(request.terminalId, false)
  state.options.onAborted?.(transfer.identity)
  return { version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION, phase: 'aborted' }
}

/** Read-only relay snapshot used to reconcile a lost commit or publication response. */
export function statusRelayPtyOwnershipTransfer(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown
): PtyOwnershipTransferStatusResult {
  const request = parsePtyOwnershipTransferStatusRequest(value)
  const transfer = requireRelayPtyOwnershipTransfer(state, request)
  return Object.freeze({
    ...transfer.identity,
    version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
    phase: transfer.phase,
    sourceOutputEndSeq: transfer.sourceOutputEndSeq,
    replayStartSeq: transfer.replayStartSeq,
    acceptedSourceEndSeq: transfer.commitReceipt?.acceptedSourceEndSeq ?? 0,
    acceptedInputIds: transfer.acceptedInputIds.size,
    ...(transfer.destinationDelegation
      ? { destinationDelegation: Object.freeze({ ...transfer.destinationDelegation }) }
      : {}),
    ...(transfer.reconnectRoute ? { reconnectGeneration: transfer.reconnectRoute.generation } : {}),
    ...(transfer.commitReceipt
      ? { commitReceipt: Object.freeze({ ...transfer.commitReceipt }) }
      : {}),
    ...(transfer.publicationReceipt
      ? { publicationReceipt: Object.freeze({ ...transfer.publicationReceipt }) }
      : {}),
    ...(transfer.surfacePublication
      ? { surfacePublication: Object.freeze({ ...transfer.surfacePublication }) }
      : {}),
    ...(transfer.exit ? { exit: structuredClone(transfer.exit) } : {})
  })
}

export type RelayPtyOwnershipTransferSnapshot = Readonly<{
  phase: 'prepared' | 'committed' | 'published' | 'aborted'
  identity: PtyOwnershipTransferWireIdentity
  sourceOutputEndSeq: number
  replayStartSeq: number
  acceptedInputIds: number
  reconnectGeneration?: number
  commitReceipt?: PtyOwnershipTransferStatusResult['commitReceipt']
  publicationReceipt?: PtyOwnershipTransferStatusResult['publicationReceipt']
  surfacePublication?: PtyOwnershipTransferStatusResult['surfacePublication']
  exit?: PtyOwnershipTransferStatusResult['exit']
}>

export function snapshotRelayPtyOwnershipTransfer(
  state: RelayPtyOwnershipTransferAdapterState,
  bridgeId: string
): RelayPtyOwnershipTransferSnapshot | null {
  const transfer = state.transfers.get(bridgeId)
  if (!transfer) {
    return null
  }
  return Object.freeze({
    phase: transfer.phase,
    identity: transfer.identity,
    sourceOutputEndSeq: transfer.sourceOutputEndSeq,
    replayStartSeq: transfer.replayStartSeq,
    acceptedInputIds: transfer.acceptedInputIds.size,
    ...(transfer.reconnectRoute ? { reconnectGeneration: transfer.reconnectRoute.generation } : {}),
    ...(transfer.commitReceipt ? { commitReceipt: structuredClone(transfer.commitReceipt) } : {}),
    ...(transfer.publicationReceipt
      ? { publicationReceipt: structuredClone(transfer.publicationReceipt) }
      : {}),
    ...(transfer.surfacePublication
      ? { surfacePublication: structuredClone(transfer.surfacePublication) }
      : {}),
    ...(transfer.exit ? { exit: structuredClone(transfer.exit) } : {})
  })
}
