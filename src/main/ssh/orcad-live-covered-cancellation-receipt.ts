import { join } from 'node:path'
import { z } from 'zod'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import { parsePtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import {
  parsePtyOwnershipTransferSuccessorRetirementRequest,
  parsePtyOwnershipTransferSuccessorRetirementResult
} from '../../shared/pty-ownership-transfer-successor-retirement'
import { parseOrcadLiveSourceRetirementRecord } from './orcad-live-source-retirement-record'
import { parseOrcadOutgoingCapture } from './orcad-outgoing-capture-store'
import { groupOrcadLiveCatalogAdmissions } from './orcad-live-catalog-admissions'
import { OrcadOutgoingEvidenceStore } from './orcad-outgoing-evidence-store'

export function parseOrcadLiveCoveredCancellationReceipt(value: unknown) {
  const header = z
    .object({
      version: z.literal(2),
      phase: z.literal('covered-source-cancellation-confirmed'),
      migrationId: z.string().min(1).max(1024),
      request: z.unknown(),
      retirement: z.unknown(),
      identity: z.unknown()
    })
    .parse(value)
  const request = parsePtyOwnershipTransferSuccessorRetirementRequest(header.request)
  const retirement = parsePtyOwnershipTransferSuccessorRetirementResult(header.retirement, request)
  const identity = parsePtyOwnershipTransferWireIdentity(header.identity)
  if (!samePtyOwnershipTransferIdentity(identity, request)) {
    throw new Error('orcad_live_covered_cancellation_identity_mismatch')
  }
  return {
    version: 2 as const,
    phase: 'covered-source-cancellation-confirmed' as const,
    migrationId: header.migrationId,
    identity,
    request,
    retirement
  }
}

/** Binds historical host custody/cancellation, not profile installation or current authority. */
export function createOrcadLiveCoveredCancellationReceipt(options: {
  record: unknown
  capture: unknown
  request: unknown
  retirement: unknown
}) {
  const record = parseOrcadLiveSourceRetirementRecord(options.record)
  const capture = parseOrcadOutgoingCapture(options.capture)
  const request = parsePtyOwnershipTransferSuccessorRetirementRequest(options.request)
  const retirement = parsePtyOwnershipTransferSuccessorRetirementResult(options.retirement, request)
  const cutover = record.release.cutover
  const catalog = groupOrcadLiveCatalogAdmissions(cutover).find((entry) =>
    entry.bindings.some((binding) => samePtyOwnershipTransferIdentity(binding.identity, request))
  )
  const publication = cutover.terminalPublications?.find((entry) =>
    samePtyOwnershipTransferIdentity(entry.identity, request)
  )
  if (
    capture.version !== 2 ||
    !catalog ||
    !publication ||
    serializeOrcadMigrationValue(retirement.coveredSourceDeliveryRetirement.receipt) !==
      serializeOrcadMigrationValue(publication.publicationReceipt.commitReceipt) ||
    request.retirementRecordSha256 !== record.sha256 ||
    !samePtyOwnershipTransferIdentity(capture.identity, request) ||
    capture.destinationEnvironmentId !== cutover.destinationEnvironmentId ||
    capture.sourceSshTargetId !== cutover.manifest.source.sshTargetId ||
    capture.sourceSshTargetGeneration !== cutover.manifest.source.sshTargetGeneration ||
    serializeOrcadMigrationValue(capture.catalogAdmission) !==
      serializeOrcadMigrationValue(catalog) ||
    serializeOrcadMigrationValue(capture.selection) !==
      serializeOrcadMigrationValue(request.savedBaseline)
  ) {
    throw new Error('orcad_live_covered_cancellation_binding_mismatch')
  }
  return parseOrcadLiveCoveredCancellationReceipt({
    version: 2,
    phase: 'covered-source-cancellation-confirmed',
    migrationId: cutover.manifest.migrationId,
    identity: capture.identity,
    request,
    retirement
  })
}

/** Rebind disk evidence to current saved records before treating it as cohort progress. */
export function validateOrcadLiveCoveredCancellationReceipt(
  value: unknown,
  record: unknown,
  capture: unknown
) {
  const receipt = parseOrcadLiveCoveredCancellationReceipt(value)
  const expected = createOrcadLiveCoveredCancellationReceipt({
    record,
    capture,
    request: receipt.request,
    retirement: receipt.retirement
  })
  if (serializeOrcadMigrationValue(expected) !== serializeOrcadMigrationValue(receipt)) {
    throw new Error('orcad_live_covered_cancellation_receipt_conflict')
  }
  return expected
}

/** Same receipt namespace, new version: ordinary readers must refuse covered progress. */
export class OrcadLiveCoveredCancellationReceiptStore extends OrcadOutgoingEvidenceStore<
  ReturnType<typeof parseOrcadLiveCoveredCancellationReceipt>
> {
  constructor(profileDirectory: string) {
    super(
      join(profileDirectory, 'orcad-live-source-cancellation-receipts'),
      parseOrcadLiveCoveredCancellationReceipt,
      'orcad_live_covered_cancellation_receipt'
    )
  }
}
