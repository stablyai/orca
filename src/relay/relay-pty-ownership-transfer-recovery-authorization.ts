import { parsePtyOwnershipTransferReconnectRekeyRequest } from '../shared/pty-ownership-transfer-reconnect-rekey-wire'
import {
  parsePtyOwnershipTransferAbortRequest,
  parsePtyOwnershipTransferStatusRequest,
  parsePtyOwnershipTransferWireIdentity
} from '../shared/pty-ownership-transfer-wire'
import {
  assertRelayPtyOwnershipTransferIdentity,
  type RelayPtyOwnershipTransferAdapterState
} from './relay-pty-ownership-transfer-adapter-state'

export function canRecoverRelayPtyOwnershipTransferPreparedAbort(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown
): boolean {
  try {
    const request = parsePtyOwnershipTransferAbortRequest(value)
    const transfer = state.transfers.get(request.bridgeId)
    if (!transfer || (transfer.phase !== 'prepared' && transfer.phase !== 'aborted')) {
      return false
    }
    assertRelayPtyOwnershipTransferIdentity(transfer, request)
    return true
  } catch {
    return false
  }
}

export function canRecoverRelayPtyOwnershipTransferStatus(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown
): boolean {
  try {
    const request = parsePtyOwnershipTransferStatusRequest(value)
    const transfer = state.transfers.get(request.bridgeId)
    if (!transfer) {
      return false
    }
    assertRelayPtyOwnershipTransferIdentity(transfer, request)
    return true
  } catch {
    return false
  }
}

export function recoverRelayPtyOwnershipTransferPostCommitRouteGeneration(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown
): number | null {
  try {
    const request = parsePtyOwnershipTransferWireIdentity(value)
    const transfer = state.transfers.get(request.bridgeId)
    if (!transfer || (transfer.phase !== 'committed' && transfer.phase !== 'published')) {
      return null
    }
    assertRelayPtyOwnershipTransferIdentity(transfer, request)
    const attachmentId = isRecord(value) ? value.attachmentId : undefined
    if (
      !transfer.reconnectRoute ||
      typeof attachmentId !== 'string' ||
      transfer.reconnectRoute.attachmentId !== attachmentId
    ) {
      return null
    }
    return transfer.reconnectRoute.generation
  } catch {
    return null
  }
}

export function canRecoverRelayPtyOwnershipTransferReconnectRekey(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown
): boolean {
  try {
    const request = parsePtyOwnershipTransferReconnectRekeyRequest(value)
    const transfer = state.transfers.get(request.bridgeId)
    if (!transfer || (transfer.phase !== 'committed' && transfer.phase !== 'published')) {
      return false
    }
    assertRelayPtyOwnershipTransferIdentity(transfer, request)
    const generation = transfer.reconnectRoute?.generation ?? transfer.identity.sourceOwnerGeneration
    return (
      (generation === request.previousReconnectGeneration &&
        request.reconnectGeneration > generation) ||
      (generation === request.reconnectGeneration &&
        transfer.reconnectRoute?.attachmentId === request.attachmentId)
    )
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
