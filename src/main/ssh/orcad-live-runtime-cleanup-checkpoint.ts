import { join } from 'node:path'
import { z } from 'zod'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { OrcadOutgoingEvidenceStore } from './orcad-outgoing-evidence-store'
import {
  createOrcadLiveSourceCleanupIntent,
  parseOrcadLiveSourceCleanupIntent,
  listValidatedOrcadLiveCleanupPreparations
} from './orcad-live-source-cleanup-intent'

export function parseOrcadLiveRuntimeCleanupCheckpoint(value: unknown) {
  const parsed = z
    .object({ phase: z.literal('runtime-surfaces-removed') })
    .passthrough()
    .parse(value)
  return {
    ...parseOrcadLiveSourceCleanupIntent({ ...parsed, phase: 'cleanup-prepared' }),
    phase: 'runtime-surfaces-removed' as const
  }
}

export function createOrcadLiveRuntimeCleanupCheckpoint(record: unknown) {
  return parseOrcadLiveRuntimeCleanupCheckpoint({
    ...createOrcadLiveSourceCleanupIntent(record),
    phase: 'runtime-surfaces-removed'
  })
}

/** Historical local cleanup checkpoint, not current ownership or source-route retirement. */
export class OrcadLiveRuntimeCleanupCheckpointStore extends OrcadOutgoingEvidenceStore<
  ReturnType<typeof parseOrcadLiveRuntimeCleanupCheckpoint>
> {
  constructor(profileDirectory: string) {
    super(
      join(profileDirectory, 'orcad-live-runtime-cleanup-checkpoints'),
      parseOrcadLiveRuntimeCleanupCheckpoint,
      'orcad_live_runtime_cleanup_checkpoint'
    )
  }
}

export function listValidatedOrcadLiveRuntimeCleanupCheckpoints(
  profileDirectory: string,
  preparations = listValidatedOrcadLiveCleanupPreparations(profileDirectory)
) {
  return new OrcadLiveRuntimeCleanupCheckpointStore(profileDirectory).list().map((checkpoint) => {
    const matches = preparations.filter(
      ({ record }) => record.sha256 === checkpoint.retirementRecordSha256
    )
    if (
      matches.length !== 1 ||
      serializeOrcadMigrationValue(createOrcadLiveRuntimeCleanupCheckpoint(matches[0].record)) !==
        serializeOrcadMigrationValue(checkpoint)
    ) {
      throw new Error('orcad_live_runtime_cleanup_checkpoint_conflict')
    }
    return { checkpoint, record: matches[0].record }
  })
}
