import { parsePtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import { parsePtyOwnershipCaptureBoundary } from '../../shared/pty-ownership-capture-boundary'
import { parsePtyOwnershipTransferSourceRetirementEvidence } from '../../shared/pty-ownership-transfer-source-retirement'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import type {
  RuntimeCapturedPtyDestinationLifecycle,
  RuntimeCapturedSourceRetirementRequest
} from './runtime-ownership-transfer-contracts'

export async function retireRuntimeCapturedSourceDelivery(options: {
  request: RuntimeCapturedSourceRetirementRequest
  runtimeId: string
  getLifecycle: () => RuntimeCapturedPtyDestinationLifecycle | undefined
  supportsPublication: () => boolean
}) {
  const { request } = options
  if (request.recoveryOnly !== undefined && typeof request.recoveryOnly !== 'boolean') {
    throw new Error('pty_source_retirement_request_invalid')
  }
  const identity = Object.freeze(parsePtyOwnershipTransferWireIdentity(request.identity))
  const hash = request.retirementRecordSha256
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error('pty_source_retirement_request_invalid')
  }
  const delivery = parsePtyOwnershipCaptureBoundary(
    { version: 1, identity, throughSeq: 0, delivery: request.expectedDelivery },
    identity
  ).delivery
  const lifecycle = options.getLifecycle()
  let active = true
  const assertCurrent = () => {
    request.signal.throwIfAborted()
    request.assertAuthority()
    if (
      !active ||
      !options.supportsPublication() ||
      identity.destinationRuntimeId !== options.runtimeId ||
      !lifecycle?.retirePublishedSourceDelivery ||
      (request.recoveryOnly && lifecycle.supportsCapturedSourceRetirementRecovery?.() !== true) ||
      options.getLifecycle() !== lifecycle
    ) {
      throw new Error('pty_ownership_transfer_captured_retirement_unavailable')
    }
  }
  try {
    assertCurrent()
    const result = parsePtyOwnershipTransferSourceRetirementEvidence(
      await lifecycle!.retirePublishedSourceDelivery!({
        identity,
        retirementRecordSha256: hash,
        expectedDelivery: delivery,
        ...(request.recoveryOnly === undefined ? {} : { recoveryOnly: request.recoveryOnly }),
        signal: request.signal,
        assertAuthority: assertCurrent,
        assertActivation: request.assertActivation
      })
    )
    assertCurrent()
    if (
      !samePtyOwnershipTransferIdentity(result, identity) ||
      result.sourceDeliveryRetirement.retirementRecordSha256 !== hash ||
      serializeOrcadMigrationValue(result.sourceDeliveryRetirement.delivery) !==
        serializeOrcadMigrationValue(delivery)
    ) {
      throw new Error('pty_source_retirement_response_mismatch')
    }
    if (request.recoveryOnly && !result.sourceCancellation) {
      throw new Error('pty_source_retirement_cancellation_required')
    }
    return result
  } finally {
    active = false
  }
}
