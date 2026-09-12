import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import {
  OrcadLiveSourceRetirementRecordStore,
  parseOrcadLiveSourceRetirementRecord
} from './orcad-live-source-retirement-record'
import {
  createOrcadLiveSourceCleanupIntent,
  OrcadLiveSourceCleanupIntentStore
} from './orcad-live-source-cleanup-intent'
import {
  createOrcadLiveRuntimeCleanupCheckpoint,
  OrcadLiveRuntimeCleanupCheckpointStore
} from './orcad-live-runtime-cleanup-checkpoint'

export async function completeOrcadLiveRuntimeSurfaceCleanup(options: {
  profileDirectory: string
  record: unknown
  cleanup: ReturnType<OrcaRuntimeService['prepareOutgoingSshPtyGraphAndModelCleanup']>
  assertAuthority: () => void
  signal: AbortSignal
}) {
  const record = parseOrcadLiveSourceRetirementRecord(options.record)
  const intent = createOrcadLiveSourceCleanupIntent(record)
  const records = new OrcadLiveSourceRetirementRecordStore(options.profileDirectory)
  const intents = new OrcadLiveSourceCleanupIntentStore(options.profileDirectory)
  const checkpoints = new OrcadLiveRuntimeCleanupCheckpointStore(options.profileDirectory)
  const expectedCheckpoint = createOrcadLiveRuntimeCleanupCheckpoint(record)
  const assertRecord = () => {
    options.signal.throwIfAborted()
    options.assertAuthority()
    if (
      serializeOrcadMigrationValue(records.read(record.identity)) !==
      serializeOrcadMigrationValue(record)
    ) {
      throw new Error('orcad_live_runtime_cleanup_record_changed')
    }
    if (
      serializeOrcadMigrationValue(intents.read(record.identity)) !==
      serializeOrcadMigrationValue(intent)
    ) {
      throw new Error('orcad_live_runtime_cleanup_intent_required')
    }
    const previous = checkpoints.read(record.identity)
    if (
      previous &&
      serializeOrcadMigrationValue(previous) !== serializeOrcadMigrationValue(expectedCheckpoint)
    ) {
      throw new Error('orcad_live_runtime_cleanup_checkpoint_conflict')
    }
  }
  assertRecord()
  // Readable bytes after an uncertain intent write do not authorize destructive cleanup.
  intents.persist(intent)
  assertRecord()
  await options.cleanup.remove(assertRecord, options.signal)
  assertRecord()
  const checkpoint = checkpoints.persist(expectedCheckpoint)
  assertRecord()
  return checkpoint
}
