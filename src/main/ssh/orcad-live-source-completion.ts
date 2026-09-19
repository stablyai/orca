import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { withOrcadLiveRuntimeRestartReadiness } from './orcad-live-runtime-restart-readiness'
import { OrcadLiveRuntimeCleanupCheckpointStore } from './orcad-live-runtime-cleanup-checkpoint'
import { OrcadLiveSourceCancellationReceiptStore } from './orcad-live-source-cancellation-receipt'
import {
  createOrcadLiveSourceCompletionPreparation,
  OrcadLiveSourceCompletionPreparationStore
} from './orcad-live-source-completion-preparation'

/** Reacknowledges the full evidence cohort; does not retire routes or release ownership. */
export function prepareOrcadLiveSourceCompletion(
  options: Parameters<typeof withOrcadLiveRuntimeRestartReadiness>[0]
) {
  return withOrcadLiveRuntimeRestartReadiness(options, async (context) => {
    const { record, outputEvidence, assertCurrent } = context
    const checkpoints = new OrcadLiveRuntimeCleanupCheckpointStore(options.profileDirectory)
    const receipts = new OrcadLiveSourceCancellationReceiptStore(options.profileDirectory)
    const preparations = new OrcadLiveSourceCompletionPreparationStore(options.profileDirectory)
    const readPreparation = () =>
      createOrcadLiveSourceCompletionPreparation({
        record,
        checkpoint: checkpoints.read(record.identity),
        settlements: outputEvidence.settlements,
        receipts: record.release.cutover.liveTerminalBindings!.map(({ identity }) =>
          receipts.read(identity)
        )
      })
    assertCurrent()
    const preparation = readPreparation()
    const expected = serializeOrcadMigrationValue(preparation)
    const assertCohort = () => {
      assertCurrent()
      if (serializeOrcadMigrationValue(readPreparation()) !== expected) {
        throw new Error('orcad_live_source_completion_evidence_changed')
      }
    }
    assertCohort()
    checkpoints.persist(preparation.checkpoint)
    assertCohort()
    for (const receipt of preparation.receipts) {
      receipts.persist(receipt)
      assertCohort()
    }
    const saved = preparations.persist(preparation)
    assertCohort()
    return saved
  })
}
