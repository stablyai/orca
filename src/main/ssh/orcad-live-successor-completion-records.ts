import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { parsePtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import { OrcadOutgoingEvidenceStore } from './orcad-outgoing-evidence-store'
import { parseOrcadLiveSourceRetirementRecord } from './orcad-live-source-retirement-record'
import { bindOrcadLiveAppliedCoverageEvidence } from './orcad-live-applied-coverage-evidence'

const digest = (value: unknown) =>
  createHash('sha256').update(serializeOrcadMigrationValue(value)).digest('hex')
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const header = z.object({
  version: z.literal(2),
  identity: z.unknown(),
  migrationId: z.string().min(1),
  retirementRecordSha256: hash,
  appliedEvidenceSha256: hash,
  cancellationCohortSha256: hash
})

/** Structural parsing is not evidence that source controls were relinquished. */
export function parseOrcadLiveSuccessorCompletionPreparation(value: unknown) {
  const parsed = header.extend({ phase: z.literal('successor-completion-prepared') }).parse(value)
  return { ...parsed, identity: parsePtyOwnershipTransferWireIdentity(parsed.identity) }
}

/** Caller must hold current successor readiness while persisting this candidate. */
export function createOrcadLiveSuccessorCompletionPreparation(
  profileDirectory: string,
  value: unknown
) {
  const record = parseOrcadLiveSourceRetirementRecord(value)
  const applied = bindOrcadLiveAppliedCoverageEvidence(profileDirectory, record)
  applied.assertCurrent()
  return parseOrcadLiveSuccessorCompletionPreparation({
    version: 2,
    phase: 'successor-completion-prepared',
    identity: record.identity,
    migrationId: record.release.cutover.manifest.migrationId,
    retirementRecordSha256: record.sha256,
    appliedEvidenceSha256: digest(applied.evidence),
    cancellationCohortSha256: applied.evidence.cancellationCohortSha256
  })
}

export class OrcadLiveSuccessorCompletionPreparationStore extends OrcadOutgoingEvidenceStore<
  ReturnType<typeof parseOrcadLiveSuccessorCompletionPreparation>
> {
  constructor(profileDirectory: string) {
    super(
      join(profileDirectory, 'orcad-live-successor-completion-preparations'),
      parseOrcadLiveSuccessorCompletionPreparation,
      'orcad_live_successor_completion_preparation'
    )
  }
}

/** Rejoins actual retained dependencies; hash-shaped references alone cannot pass. */
export function bindOrcadLiveSuccessorCompletionPreparation(
  profileDirectory: string,
  value: unknown
) {
  const record = parseOrcadLiveSourceRetirementRecord(value)
  const store = new OrcadLiveSuccessorCompletionPreparationStore(profileDirectory)
  const preparation = createOrcadLiveSuccessorCompletionPreparation(profileDirectory, record)
  const expected = serializeOrcadMigrationValue(preparation)
  const assertCurrent = () => {
    if (
      serializeOrcadMigrationValue(store.read(record.identity)) !== expected ||
      serializeOrcadMigrationValue(
        createOrcadLiveSuccessorCompletionPreparation(profileDirectory, record)
      ) !== expected
    ) {
      throw new Error('orcad_live_successor_completion_preparation_changed')
    }
  }
  assertCurrent()
  return { preparation, assertCurrent }
}

export function parseOrcadLiveSuccessorRouteCheckpoint(value: unknown) {
  const parsed = header
    .extend({
      phase: z.literal('successor-source-routes-refused'),
      completionPreparationSha256: hash
    })
    .parse(value)
  return { ...parsed, identity: parsePtyOwnershipTransferWireIdentity(parsed.identity) }
}

export function createOrcadLiveSuccessorRouteCheckpoint(value: unknown) {
  const preparation = parseOrcadLiveSuccessorCompletionPreparation(value)
  return parseOrcadLiveSuccessorRouteCheckpoint({
    ...preparation,
    phase: 'successor-source-routes-refused',
    completionPreparationSha256: digest(preparation)
  })
}

/** Records exact route refusal, not deletion history or whole-migration completion. */
export class OrcadLiveSuccessorRouteCheckpointStore extends OrcadOutgoingEvidenceStore<
  ReturnType<typeof parseOrcadLiveSuccessorRouteCheckpoint>
> {
  constructor(profileDirectory: string) {
    super(
      join(profileDirectory, 'orcad-live-successor-route-checkpoints'),
      parseOrcadLiveSuccessorRouteCheckpoint,
      'orcad_live_successor_route_checkpoint'
    )
  }
}

export function bindOrcadLiveSuccessorRouteCheckpoint(profileDirectory: string, value: unknown) {
  const record = parseOrcadLiveSourceRetirementRecord(value)
  const bound = bindOrcadLiveSuccessorCompletionPreparation(profileDirectory, record)
  const store = new OrcadLiveSuccessorRouteCheckpointStore(profileDirectory)
  const checkpoint = createOrcadLiveSuccessorRouteCheckpoint(bound.preparation)
  const expected = serializeOrcadMigrationValue(checkpoint)
  const assertCurrent = () => {
    bound.assertCurrent()
    if (serializeOrcadMigrationValue(store.read(record.identity)) !== expected) {
      throw new Error('orcad_live_successor_route_checkpoint_changed')
    }
  }
  assertCurrent()
  return { preparation: bound.preparation, checkpoint, assertCurrent }
}

/** Historical references only; a completed journal still requires current successor authority. */
export function readOrcadLiveSuccessorCompletionEvidence(profileDirectory: string, value: unknown) {
  const record = parseOrcadLiveSourceRetirementRecord(value)
  const bound = bindOrcadLiveSuccessorRouteCheckpoint(profileDirectory, record)
  bound.assertCurrent()
  return {
    version: 2 as const,
    retirementRecordSha256: record.sha256,
    sourceRouteCheckpointSha256: digest(bound.checkpoint)
  }
}
