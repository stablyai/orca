import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { withOrcadLiveRuntimeRestartReadiness } from './orcad-live-runtime-restart-readiness'
import {
  createOrcadLiveRuntimeCleanupCheckpoint,
  OrcadLiveRuntimeCleanupCheckpointStore
} from './orcad-live-runtime-cleanup-checkpoint'

/** Reacknowledges existing local cleanup only; never infers that host retirement has started. */
export function reflushOrcadLiveRuntimeCleanupCheckpoint(
  options: Parameters<typeof withOrcadLiveRuntimeRestartReadiness>[0]
) {
  return withOrcadLiveRuntimeRestartReadiness(options, async ({ record, assertCurrent }) => {
    const store = new OrcadLiveRuntimeCleanupCheckpointStore(options.profileDirectory)
    const checkpoint = createOrcadLiveRuntimeCleanupCheckpoint(record)
    const expected = serializeOrcadMigrationValue(checkpoint)
    const assertCheckpoint = () => {
      assertCurrent()
      if (serializeOrcadMigrationValue(store.read(record.identity)) !== expected) {
        throw new Error('orcad_live_runtime_cleanup_checkpoint_required')
      }
    }
    assertCheckpoint()
    const acknowledged = store.persist(checkpoint)
    assertCheckpoint()
    return acknowledged
  })
}
