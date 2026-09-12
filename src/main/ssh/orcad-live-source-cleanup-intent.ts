import { join } from 'node:path'
import { z } from 'zod'
import { parsePtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import { OrcadOutgoingEvidenceStore } from './orcad-outgoing-evidence-store'
import {
  parseOrcadLiveSourceRetirementRecord,
  OrcadLiveSourceRetirementRecordStore
} from './orcad-live-source-retirement-record'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'

const header = z.object({
  version: z.literal(1),
  phase: z.literal('cleanup-prepared'),
  retirementRecordSha256: z.string().regex(/^[a-f0-9]{64}$/),
  migrationId: z.string().min(1).max(1024),
  identity: z.unknown()
})

export function parseOrcadLiveSourceCleanupIntent(value: unknown) {
  const parsed = header.parse(value)
  return { ...parsed, identity: parsePtyOwnershipTransferWireIdentity(parsed.identity) }
}

export function createOrcadLiveSourceCleanupIntent(value: unknown) {
  const record = parseOrcadLiveSourceRetirementRecord(value)
  return parseOrcadLiveSourceCleanupIntent({
    version: 1,
    phase: 'cleanup-prepared',
    identity: record.identity,
    retirementRecordSha256: record.sha256,
    migrationId: record.release.cutover.manifest.migrationId
  })
}

/** Durable attempt only; cleanup and restart recovery still require fresh authority. */
export class OrcadLiveSourceCleanupIntentStore extends OrcadOutgoingEvidenceStore<
  ReturnType<typeof parseOrcadLiveSourceCleanupIntent>
> {
  constructor(profileDirectory: string) {
    super(
      join(profileDirectory, 'orcad-live-source-cleanup-intents'),
      parseOrcadLiveSourceCleanupIntent,
      'orcad_live_source_cleanup_intent'
    )
  }
}

export function listValidatedOrcadLiveCleanupPreparations(
  profileDirectory: string,
  records = new OrcadLiveSourceRetirementRecordStore(profileDirectory).list()
) {
  return new OrcadLiveSourceCleanupIntentStore(profileDirectory).list().map((intent) => {
    const matches = records.filter((record) => record.sha256 === intent.retirementRecordSha256)
    const record = matches[0]
    if (
      matches.length !== 1 ||
      serializeOrcadMigrationValue(createOrcadLiveSourceCleanupIntent(record)) !==
        serializeOrcadMigrationValue(intent)
    ) {
      throw new Error('orcad_live_cleanup_recovery_record_conflict')
    }
    return { intent, record }
  })
}
