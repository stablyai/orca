import { bindOrcadCapturedRuntimeRequest } from './orcad-captured-runtime-request'
import { parseOrcadCatalogActivationRequest } from './orcad-catalog-activation-contract'
import { parsePtyOwnershipCaptureBoundary } from '../../shared/pty-ownership-capture-boundary'
import { parsePtyOwnershipTransferSourceRetirementEvidence } from '../../shared/pty-ownership-transfer-source-retirement'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { assertOrcadMigrationManifestDigest } from '../orcad/orcad-migration-manifest-digest'
import {
  PTY_CAPTURED_DESTINATION_CAPABILITIES_METHOD,
  PTY_CAPTURED_SOURCE_RETIREMENT_METHOD
} from '../../shared/pty-ownership-transfer-runtime-methods'

export async function retireRemoteOrcadCapturedSourceDelivery(options: {
  pairingCode: string
  request: Parameters<typeof parseOrcadCatalogActivationRequest>[0] & {
    retirementRecordSha256: string
    expectedDelivery: unknown
    recoveryOnly?: boolean
  }
  signal: AbortSignal
  timeoutMs?: number
  assertAuthority: () => void
}) {
  options.signal.throwIfAborted()
  options.assertAuthority()
  if (
    options.request.recoveryOnly !== undefined &&
    typeof options.request.recoveryOnly !== 'boolean'
  ) {
    throw new Error('pty_source_retirement_request_invalid')
  }
  const expected = parseOrcadCatalogActivationRequest(options.request)
  assertOrcadMigrationManifestDigest(expected.catalogAdmission.manifest)
  const hash = options.request.retirementRecordSha256
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error('pty_source_retirement_request_invalid')
  }
  const delivery = parsePtyOwnershipCaptureBoundary(
    {
      version: 1,
      identity: expected.identity,
      throughSeq: 0,
      delivery: options.request.expectedDelivery
    },
    expected.identity
  ).delivery
  const send = bindOrcadCapturedRuntimeRequest({
    ...options,
    runtimeId: expected.identity.destinationRuntimeId,
    errorPrefix: 'orcad_captured_source_retirement'
  })
  const support = (await send(PTY_CAPTURED_DESTINATION_CAPABILITIES_METHOD, {
    version: 1
  })) as Record<string, unknown> | null
  if (support?.version !== 1 || support.sourceRetirement !== 1) {
    throw new Error('orcad_captured_source_retirement_negotiation_required')
  }
  if (options.request.recoveryOnly && support.sourceRetirementRecovery !== 1) {
    throw new Error('orcad_captured_source_retirement_recovery_negotiation_required')
  }
  const result = parsePtyOwnershipTransferSourceRetirementEvidence(
    await send(PTY_CAPTURED_SOURCE_RETIREMENT_METHOD, {
      version: 1,
      ...expected,
      retirementRecordSha256: hash,
      expectedDelivery: delivery,
      ...(options.request.recoveryOnly === undefined
        ? {}
        : { recoveryOnly: options.request.recoveryOnly })
    })
  )
  if (
    !samePtyOwnershipTransferIdentity(result, expected.identity) ||
    result.sourceDeliveryRetirement.retirementRecordSha256 !== hash ||
    serializeOrcadMigrationValue(result.sourceDeliveryRetirement.delivery) !==
      serializeOrcadMigrationValue(delivery)
  ) {
    throw new Error('orcad_captured_source_retirement_response_mismatch')
  }
  if (options.request.recoveryOnly && !result.sourceCancellation) {
    throw new Error('orcad_captured_source_retirement_cancellation_required')
  }
  return result
}
