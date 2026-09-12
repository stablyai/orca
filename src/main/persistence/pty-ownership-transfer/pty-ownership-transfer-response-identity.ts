import type { PtyOwnershipTransferIdentity } from '../../../shared/pty-ownership-transfer-journal-contract'
import { samePtyOwnershipTransferIdentity } from '../../../shared/pty-ownership-transfer-identity'

export function assertTransferIdentity(
  value: PtyOwnershipTransferIdentity,
  expected: PtyOwnershipTransferIdentity
): void {
  if (!samePtyOwnershipTransferIdentity(value, expected)) {
    throw new Error('pty_ownership_transfer_response_identity_mismatch')
  }
}
