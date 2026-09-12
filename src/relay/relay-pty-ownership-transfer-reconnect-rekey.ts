import {
  parsePtyOwnershipTransferReconnectRekeyRequest,
  type PtyOwnershipTransferReconnectRekeyResult
} from '../shared/pty-ownership-transfer-reconnect-rekey-wire'
import { PTY_OWNERSHIP_TRANSFER_WIRE_VERSION } from '../shared/pty-ownership-transfer-wire'
import { persistRelayPtyOwnershipTransfer } from './relay-pty-ownership-transfer-adapter-persistence'
import {
  requireRelayPtyOwnershipTransfer,
  relayPtyOwnershipTransferExecutionVerdict,
  type RelayPtyOwnershipTransferAdapterState,
  type RelayPtyOwnershipTransferAttachmentBinding
} from './relay-pty-ownership-transfer-adapter-state'
import { RelayPtyOwnershipTransferError } from './relay-pty-ownership-transfer-errors'
import { assertRelayPtyOwnershipTransferLegacyDestination } from './relay-pty-ownership-transfer-source-route-authorization'

/** Durably advances a committed route before binding it to the resumed relay socket. */
export function rekeyRelayPtyOwnershipTransferReconnect(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown,
  binding?: RelayPtyOwnershipTransferAttachmentBinding
): PtyOwnershipTransferReconnectRekeyResult {
  const request = parsePtyOwnershipTransferReconnectRekeyRequest(value)
  const transfer = requireRelayPtyOwnershipTransfer(state, request)
  assertRelayPtyOwnershipTransferLegacyDestination(transfer)
  if (transfer.phase !== 'committed' && transfer.phase !== 'published') {
    throw new RelayPtyOwnershipTransferError(
      'invalid-phase',
      'a reconnect route can only be rekeyed after commit'
    )
  }
  const currentRoute = transfer.reconnectRoute
  if (currentRoute?.generation === request.reconnectGeneration) {
    if (currentRoute.attachmentId !== request.attachmentId) {
      throw staleReconnectGeneration()
    }
    bindRoute(transfer, request.attachmentId, binding)
    return result(state, transfer, request)
  }
  const currentGeneration = currentRoute?.generation ?? transfer.identity.sourceOwnerGeneration
  if (currentGeneration !== request.previousReconnectGeneration) {
    throw staleReconnectGeneration()
  }

  const previousRoute = transfer.reconnectRoute
  const previousAttachmentId = transfer.attachmentId
  const previousBinding = transfer.attachmentBinding
  transfer.reconnectRoute = Object.freeze({
    generation: request.reconnectGeneration,
    attachmentId: request.attachmentId
  })
  bindRoute(transfer, request.attachmentId, binding)
  try {
    persistRelayPtyOwnershipTransfer(state, transfer)
  } catch (error) {
    transfer.reconnectRoute = previousRoute
    transfer.attachmentId = previousAttachmentId
    transfer.attachmentBinding = previousBinding
    throw error
  }
  return result(state, transfer, request)
}

function bindRoute(
  transfer: ReturnType<typeof requireRelayPtyOwnershipTransfer>,
  attachmentId: string,
  binding?: RelayPtyOwnershipTransferAttachmentBinding
): void {
  transfer.attachmentId = attachmentId
  transfer.attachmentBinding = binding ? Object.freeze({ ...binding }) : undefined
}

function result(
  state: RelayPtyOwnershipTransferAdapterState,
  transfer: ReturnType<typeof requireRelayPtyOwnershipTransfer>,
  request: ReturnType<typeof parsePtyOwnershipTransferReconnectRekeyRequest>
): PtyOwnershipTransferReconnectRekeyResult {
  const executionVerdict = relayPtyOwnershipTransferExecutionVerdict(state, transfer)
  return Object.freeze({
    ...transfer.identity,
    version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
    previousReconnectGeneration: request.previousReconnectGeneration,
    reconnectGeneration: request.reconnectGeneration,
    attachmentId: request.attachmentId,
    phase: transfer.phase as 'committed' | 'published',
    executionVerdict,
    ...(transfer.exit ? { exit: structuredClone(transfer.exit) } : {})
  })
}

function staleReconnectGeneration(): RelayPtyOwnershipTransferError {
  return new RelayPtyOwnershipTransferError(
    'stale-reconnect-generation',
    'reconnect rekey does not advance the exact durable route generation'
  )
}
