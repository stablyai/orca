import { createHash } from 'node:crypto'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { parseOrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import { parseOrcadLiveSourceCompletionEvidence } from '../../shared/orcad-live-source-completion-evidence'
import { parseOrcadLiveSourceRetirementRecord } from './orcad-live-source-retirement-record'
import {
  createOrcadLiveSourceCompletionPreparation,
  parseOrcadLiveSourceCompletionPreparation,
  listValidatedOrcadLiveSourceCompletionPreparations
} from './orcad-live-source-completion-preparation'
import {
  createOrcadLiveSourceRouteCheckpoint,
  parseOrcadLiveSourceRouteCheckpoint,
  listValidatedOrcadLiveSourceRouteCheckpoints
} from './orcad-live-source-route-checkpoint'
import { listValidatedOrcadLiveCleanupOutputEvidence } from './orcad-live-cleanup-output-evidence'

/** Evidence construction only; neither current authority nor completed persistence is inferred. */
export function createOrcadLiveSourceCompletionEvidence(options: {
  record: unknown
  committed: unknown
  preparation: unknown
  settlements: unknown
  checkpoint: unknown
}) {
  const record = parseOrcadLiveSourceRetirementRecord(options.record)
  const committed = parseOrcadMigrationSourceCutover(options.committed)
  if (
    serializeOrcadMigrationValue(committed) !== serializeOrcadMigrationValue(record.release.cutover)
  ) {
    throw new Error('orcad_live_source_completion_committed_mismatch')
  }
  const supplied = parseOrcadLiveSourceCompletionPreparation(options.preparation)
  const preparation = createOrcadLiveSourceCompletionPreparation({
    record,
    checkpoint: supplied.checkpoint,
    settlements: options.settlements,
    receipts: supplied.receipts
  })
  if (serializeOrcadMigrationValue(supplied) !== serializeOrcadMigrationValue(preparation)) {
    throw new Error('orcad_live_source_completion_preparation_mismatch')
  }
  const checkpoint = parseOrcadLiveSourceRouteCheckpoint(options.checkpoint)
  if (
    serializeOrcadMigrationValue(checkpoint) !==
    serializeOrcadMigrationValue(createOrcadLiveSourceRouteCheckpoint(preparation))
  ) {
    throw new Error('orcad_live_source_completion_route_checkpoint_mismatch')
  }
  return parseOrcadLiveSourceCompletionEvidence({
    version: 1,
    retirementRecordSha256: record.sha256,
    sourceRouteCheckpointSha256: createHash('sha256')
      .update(serializeOrcadMigrationValue(checkpoint))
      .digest('hex')
  })
}

/** Discovery joins actual files; structurally valid hash-shaped references alone are insufficient. */
export function readOrcadLiveSourceCompletionEvidence(
  profileDirectory: string,
  committedValue: unknown
) {
  const committed = parseOrcadMigrationSourceCutover(committedValue)
  const outputs = listValidatedOrcadLiveCleanupOutputEvidence(profileDirectory)
  const preparations = listValidatedOrcadLiveSourceCompletionPreparations(profileDirectory, outputs)
  const checkpoints = listValidatedOrcadLiveSourceRouteCheckpoints(profileDirectory, preparations)
  const matches = preparations.filter(
    ({ record }) =>
      serializeOrcadMigrationValue(record.release.cutover) ===
      serializeOrcadMigrationValue(committed)
  )
  if (matches.length !== 1) {
    throw new Error('orcad_live_source_completion_preparation_required')
  }
  const { record, preparation } = matches[0]
  const output = outputs.filter((entry) => entry.record.sha256 === record.sha256)
  const routes = checkpoints.filter((entry) => entry.record.sha256 === record.sha256)
  if (output.length !== 1 || routes.length !== 1) {
    throw new Error('orcad_live_source_completion_route_checkpoint_required')
  }
  return createOrcadLiveSourceCompletionEvidence({
    record,
    committed,
    preparation,
    settlements: output[0].evidence.settlements,
    checkpoint: routes[0].checkpoint
  })
}
