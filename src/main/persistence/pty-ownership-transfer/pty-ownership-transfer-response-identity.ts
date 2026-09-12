import type { PtyOwnershipTransferIdentity } from '../../../shared/pty-ownership-transfer-journal-contract'

export function assertTransferIdentity(
  value: PtyOwnershipTransferIdentity,
  expected: PtyOwnershipTransferIdentity
): void {
  if (
    value.bridgeId !== expected.bridgeId ||
    value.terminalId !== expected.terminalId ||
    value.incarnationId !== expected.incarnationId ||
    value.ownerLease !== expected.ownerLease ||
    value.sourceOwnerGeneration !== expected.sourceOwnerGeneration ||
    value.destinationRuntimeId !== expected.destinationRuntimeId
  ) {
    throw new Error('pty_ownership_transfer_response_identity_mismatch')
  }
}
