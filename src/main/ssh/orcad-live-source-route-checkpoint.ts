import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { parseOrcadLiveSourceCleanupIntent } from './orcad-live-source-cleanup-intent'
import { OrcadOutgoingEvidenceStore } from './orcad-outgoing-evidence-store'
import {
  parseOrcadLiveSourceCompletionPreparation,
  listValidatedOrcadLiveSourceCompletionPreparations
} from './orcad-live-source-completion-preparation'

export function parseOrcadLiveSourceRouteCheckpoint(value: unknown) {
  const parsed = z
    .object({
      phase: z.literal('source-routes-removed'),
      completionPreparationSha256: z.string().regex(/^[a-f0-9]{64}$/)
    })
    .passthrough()
    .parse(value)
  return {
    ...parseOrcadLiveSourceCleanupIntent({ ...parsed, phase: 'cleanup-prepared' }),
    phase: 'source-routes-removed' as const,
    completionPreparationSha256: parsed.completionPreparationSha256
  }
}

export function createOrcadLiveSourceRouteCheckpoint(value: unknown) {
  const preparation = parseOrcadLiveSourceCompletionPreparation(value)
  return parseOrcadLiveSourceRouteCheckpoint({
    ...preparation,
    phase: 'source-routes-removed',
    completionPreparationSha256: createHash('sha256')
      .update(serializeOrcadMigrationValue(preparation))
      .digest('hex')
  })
}

/** Historical registry removal only; never authorizes host shutdown or evidence deletion. */
export class OrcadLiveSourceRouteCheckpointStore extends OrcadOutgoingEvidenceStore<
  ReturnType<typeof parseOrcadLiveSourceRouteCheckpoint>
> {
  constructor(profileDirectory: string) {
    super(
      join(profileDirectory, 'orcad-live-source-route-checkpoints'),
      parseOrcadLiveSourceRouteCheckpoint,
      'orcad_live_source_route_checkpoint'
    )
  }
}

export function listValidatedOrcadLiveSourceRouteCheckpoints(
  profileDirectory: string,
  preparations = listValidatedOrcadLiveSourceCompletionPreparations(profileDirectory)
) {
  return new OrcadLiveSourceRouteCheckpointStore(profileDirectory).list().map((checkpoint) => {
    const matches = preparations.filter(
      ({ record }) => record.sha256 === checkpoint.retirementRecordSha256
    )
    if (
      matches.length !== 1 ||
      serializeOrcadMigrationValue(createOrcadLiveSourceRouteCheckpoint(matches[0].preparation)) !==
        serializeOrcadMigrationValue(checkpoint)
    ) {
      throw new Error('orcad_live_source_route_checkpoint_conflict')
    }
    return { record: matches[0].record, checkpoint }
  })
}
