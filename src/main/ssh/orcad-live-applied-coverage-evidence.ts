import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { parsePtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import { OrcadOutgoingEvidenceStore } from './orcad-outgoing-evidence-store'
import { parseOrcadLiveSourceRetirementRecord } from './orcad-live-source-retirement-record'
import { bindOrcadLiveCancellationCohort } from './orcad-live-cancellation-cohort'
import { groupOrcadLiveCatalogAdmissions } from './orcad-live-catalog-admissions'
import { parseOrcadCatalogOutputCoverageResult } from './orcad-catalog-output-coverage-contract'
import {
  assertOrcadLiveSourceReleaseCompatible,
  parseOrcadLiveSourceReleaseIntent
} from './orcad-live-source-release-intent'

const digest = (value: unknown) =>
  createHash('sha256').update(serializeOrcadMigrationValue(value)).digest('hex')

function parseEvidence(value: unknown) {
  const parsed = z
    .object({
      version: z.literal(1),
      phase: z.literal('destination-output-applied'),
      identity: z.unknown(),
      retirementRecordSha256: z.string().regex(/^[a-f0-9]{64}$/),
      cancellationCohortSha256: z.string().regex(/^[a-f0-9]{64}$/),
      coverages: z.array(z.unknown())
    })
    .parse(value)
  return { ...parsed, identity: parsePtyOwnershipTransferWireIdentity(parsed.identity) }
}

/** Historical applied output only; current controls, routes and completion need separate authority. */
export class OrcadLiveAppliedCoverageEvidenceStore extends OrcadOutgoingEvidenceStore<
  ReturnType<typeof parseEvidence>
> {
  constructor(profileDirectory: string) {
    super(
      join(profileDirectory, 'orcad-live-applied-coverage-evidence'),
      parseEvidence,
      'orcad_live_applied_coverage_evidence'
    )
  }
}

/** Rejoins actual cancellation dependencies; hash-shaped references alone are not evidence. */
export function createOrcadLiveAppliedCoverageEvidence(options: {
  profileDirectory: string
  record: unknown
  coverages: readonly unknown[]
}) {
  const record = parseOrcadLiveSourceRetirementRecord(options.record)
  const cohort = bindOrcadLiveCancellationCohort(options.profileDirectory, record)
  const covered = cohort.receipts.filter((receipt) => receipt.version === 2)
  const supplied = options.coverages.map((value) => ({
    value,
    identity: parsePtyOwnershipTransferWireIdentity(
      z.object({ identity: z.unknown() }).parse(value).identity
    )
  }))
  if (supplied.length !== covered.length) {
    throw new Error('orcad_live_applied_coverage_cohort_incomplete')
  }
  const admissions = groupOrcadLiveCatalogAdmissions(record.release.cutover)
  const coverages = covered.map((receipt) => {
    const matches = supplied.filter((entry) =>
      samePtyOwnershipTransferIdentity(entry.identity, receipt.identity)
    )
    if (matches.length !== 1) {
      throw new Error('orcad_live_applied_coverage_cohort_incomplete')
    }
    const original = record.release.activations.find((entry) =>
      samePtyOwnershipTransferIdentity(entry.identity, receipt.identity)
    )!
    const observed = parseOrcadCatalogOutputCoverageResult(matches[0].value, {
      identity: receipt.identity,
      publicationReceipt: original.publicationReceipt,
      catalogAdmission: admissions.find((entry) =>
        entry.bindings.some((binding) =>
          samePtyOwnershipTransferIdentity(binding.identity, receipt.identity)
        )
      )!,
      throughSeq: receipt.retirement.coveredSourceDeliveryRetirement.sourceOutputEndSeq
    })
    assertOrcadLiveSourceReleaseCompatible(
      parseOrcadLiveSourceReleaseIntent({
        ...record.release,
        activations: record.release.activations.map((entry) =>
          entry === original ? observed : entry
        )
      }),
      record.release
    )
    return observed
  })
  cohort.assertCancellation(record)
  return {
    version: 1 as const,
    phase: 'destination-output-applied' as const,
    identity: record.identity,
    retirementRecordSha256: record.sha256,
    cancellationCohortSha256: digest(cohort.receipts),
    coverages
  }
}

export function bindOrcadLiveAppliedCoverageEvidence(profileDirectory: string, value: unknown) {
  const record = parseOrcadLiveSourceRetirementRecord(value)
  const store = new OrcadLiveAppliedCoverageEvidenceStore(profileDirectory)
  const read = () => {
    const saved = store.read(record.identity)
    if (!saved) {
      throw new Error('orcad_live_applied_coverage_evidence_required')
    }
    const expected = createOrcadLiveAppliedCoverageEvidence({
      profileDirectory,
      record,
      coverages: saved.coverages
    })
    if (serializeOrcadMigrationValue(saved) !== serializeOrcadMigrationValue(expected)) {
      throw new Error('orcad_live_applied_coverage_evidence_conflict')
    }
    return expected
  }
  const evidence = read()
  const canonical = serializeOrcadMigrationValue(evidence)
  return {
    evidence,
    assertCurrent: () => {
      if (serializeOrcadMigrationValue(read()) !== canonical) {
        throw new Error('orcad_live_applied_coverage_evidence_changed')
      }
    }
  }
}
