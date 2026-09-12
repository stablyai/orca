import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import {
  parsePtyOwnershipTransferWireIdentity,
  type PtyOwnershipTransferStatusResult
} from '../../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipTransferStatusProbeRequest } from '../../shared/pty-ownership-transfer-orchestration'

export function assertPtyOwnershipTransferStatusRequest(
  request: PtyOwnershipTransferStatusProbeRequest
): void {
  parsePtyOwnershipTransferWireIdentity(request.identity)
  if (
    request.timeoutMs !== undefined &&
    (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0)
  ) {
    throw new Error('pty_ownership_transfer_status_timeout_invalid')
  }
}

export function assertDirectSshPtyOwnershipTransferStatusIdentity(
  request: PtyOwnershipTransferStatusProbeRequest,
  runtimeId: string
): void {
  const parsed = parseAppSshPtyId(request.ptyId)
  if (
    !parsed ||
    request.identity.terminalId !== parsed.relayPtyId ||
    request.identity.destinationRuntimeId !== runtimeId
  ) {
    throw new Error('pty_ownership_transfer_status_identity_mismatch')
  }
}

export function assertRuntimeOwnedPtyOwnershipTransferStatusIdentity(
  request: PtyOwnershipTransferStatusProbeRequest
): void {
  if (
    request.connectionId !== null ||
    request.identity.terminalId !== request.ptyId ||
    request.identity.destinationRuntimeId !== request.destinationRuntimeId
  ) {
    throw new Error('pty_ownership_transfer_status_identity_mismatch')
  }
}

export function assertPtyOwnershipTransferStatusResponseIdentity(
  response: PtyOwnershipTransferStatusResult,
  expected: PtyOwnershipTransferStatusProbeRequest['identity']
): void {
  if (
    response.bridgeId !== expected.bridgeId ||
    response.terminalId !== expected.terminalId ||
    response.incarnationId !== expected.incarnationId ||
    response.ownerLease !== expected.ownerLease ||
    response.sourceOwnerGeneration !== expected.sourceOwnerGeneration ||
    response.destinationRuntimeId !== expected.destinationRuntimeId
  ) {
    throw new Error('pty_ownership_transfer_response_identity_mismatch')
  }
}
