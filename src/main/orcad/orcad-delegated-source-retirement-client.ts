import { parsePtyOwnershipCaptureBoundary } from '../../shared/pty-ownership-capture-boundary'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_STATUS_METHOD } from '../../shared/pty-ownership-transfer-destination-claim'
import { parsePtyOwnershipTransferDestinationStatus } from '../../shared/pty-ownership-transfer-destination-status'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import {
  PTY_OWNERSHIP_TRANSFER_SOURCE_RETIREMENT_METHOD,
  parsePtyOwnershipTransferSourceRetirementRequest,
  parsePtyOwnershipTransferSourceRetirementResult
} from '../../shared/pty-ownership-transfer-source-retirement'
import type {
  PtyOwnershipTransferRequestOptions,
  PtyOwnershipTransferRequestTransport
} from '../providers/ssh-pty-ownership-transfer-client'

export async function retireOrcadSourceDelivery(
  transport: PtyOwnershipTransferRequestTransport,
  value: unknown,
  expectedDelivery: unknown,
  options?: PtyOwnershipTransferRequestOptions,
  assertAuthority?: () => void
) {
  const request = parsePtyOwnershipTransferSourceRetirementRequest(value)
  const { delivery } = parsePtyOwnershipCaptureBoundary(
    {
      version: 1,
      identity: request,
      throughSeq: 0,
      delivery: expectedDelivery
    },
    request
  )
  const assertCurrent = () => {
    options?.signal?.throwIfAborted()
    assertAuthority?.()
  }
  assertCurrent()
  const status = parsePtyOwnershipTransferDestinationStatus(
    await transport(PTY_OWNERSHIP_TRANSFER_DESTINATION_STATUS_METHOD, request, options)
  )
  assertCurrent()
  if (status.sourceRetirementVersion !== 1 || status.sourceRetirementBoundaryVersion !== 1) {
    throw new Error('orcad_source_retirement_unsupported')
  }
  if (request.recoveryOnly && status.sourceRetirementRecoveryVersion !== 1) {
    throw new Error('orcad_source_retirement_recovery_unsupported')
  }
  if (
    !samePtyOwnershipTransferIdentity(status, request) ||
    status.phase !== 'committed' ||
    !status.boundToConnection ||
    status.destinationClaim?.generation !== request.destinationClaim.generation ||
    status.destinationClaim.claimId !== request.destinationClaim.claimId
  ) {
    throw new Error('orcad_source_retirement_claim_mismatch')
  }
  const result = await transport(
    PTY_OWNERSHIP_TRANSFER_SOURCE_RETIREMENT_METHOD,
    { ...request, expectedDelivery: delivery },
    options
  )
  assertCurrent()
  const parsed = parsePtyOwnershipTransferSourceRetirementResult(result, request, delivery)
  if (request.recoveryOnly && !parsed.sourceCancellation) {
    throw new Error('orcad_source_retirement_cancellation_required')
  }
  return parsed
}
