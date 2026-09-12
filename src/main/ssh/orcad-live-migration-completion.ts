import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { withOrcadLiveRuntimeRestartReadiness } from './orcad-live-runtime-restart-readiness'
import { readOrcadLiveSourceCompletionEvidence } from './orcad-live-source-completion-evidence'
import {
  createOrcadLiveCompletedCutover,
  assertOrcadLiveCompletedCutover
} from './orcad-live-completed-cutover'
import { restoreRetiredOutgoingSshPtyRoutes } from '../ipc/pty/provider/outgoing-source-route-retirement'
import { OrcadLiveSourceCompletionPreparationStore } from './orcad-live-source-completion-preparation'
import { OrcadLiveSourceRouteCheckpointStore } from './orcad-live-source-route-checkpoint'
import { OrcadLiveSourceCancellationReceiptStore } from './orcad-live-source-cancellation-receipt'
import { OrcadLiveRuntimeCleanupCheckpointStore } from './orcad-live-runtime-cleanup-checkpoint'

/** Completion is acknowledged only after the exact final profile journal has been flushed. */
export function completeOrcadLiveMigration(
  options: Parameters<typeof withOrcadLiveRuntimeRestartReadiness>[0] & { now?: () => Date }
) {
  return withOrcadLiveRuntimeRestartReadiness(
    { ...options, allowCompleted: true },
    async (context) => {
      const { record, assertCurrent, transitionCompletedJournal } = context
      const committed = record.release.cutover
      const completionEvidence = readOrcadLiveSourceCompletionEvidence(
        options.profileDirectory,
        committed
      )
      const expected = serializeOrcadMigrationValue(completionEvidence)
      const assertEvidence = () => {
        assertCurrent()
        if (
          serializeOrcadMigrationValue(
            readOrcadLiveSourceCompletionEvidence(options.profileDirectory, committed)
          ) !== expected
        ) {
          throw new Error('orcad_live_completion_evidence_changed')
        }
      }
      const routes = restoreRetiredOutgoingSshPtyRoutes({
        targetId: committed.manifest.source.sshTargetId,
        identities: committed.liveTerminalBindings!.map(({ identity }) => identity),
        recordSha256: record.sha256,
        assertAuthority: assertEvidence
      })
      const journal = options.store
        .listOrcadMigrationSourceCutovers()
        .find((entry) => entry.manifest.migrationId === options.migrationId)
      const candidate =
        journal?.phase === 'source-retired'
          ? assertOrcadLiveCompletedCutover({ committed, completed: journal, completionEvidence })
          : createOrcadLiveCompletedCutover({
              committed,
              completionEvidence,
              retiredAt: (options.now?.() ?? new Date()).toISOString()
            })
      const preparations = new OrcadLiveSourceCompletionPreparationStore(options.profileDirectory)
      const checkpoints = new OrcadLiveSourceRouteCheckpointStore(options.profileDirectory)
      const preparation = preparations.read(record.identity)
      const checkpoint = checkpoints.read(record.identity)
      if (!preparation || !checkpoint) {
        throw new Error('orcad_live_completion_evidence_required')
      }
      const receipts = new OrcadLiveSourceCancellationReceiptStore(options.profileDirectory)
      const runtimeCheckpoints = new OrcadLiveRuntimeCleanupCheckpointStore(
        options.profileDirectory
      )
      routes.assertRetired()
      for (const receipt of preparation.receipts) {
        receipts.persist(receipt)
        routes.assertRetired()
      }
      runtimeCheckpoints.persist(preparation.checkpoint)
      routes.assertRetired()
      preparations.persist(preparation)
      routes.assertRetired()
      checkpoints.persist(checkpoint)
      routes.assertRetired()
      transitionCompletedJournal(candidate, () => {
        options.store.completeOrcadLiveRetirementProfile(record, candidate, {
          completionEvidence,
          assertCurrent: routes.assertRetired
        })
      })
      routes.assertRetired()
      await options.store.flushPendingOrThrowAsync({
        signal: options.signal,
        drainToStableGeneration: false
      })
      routes.assertRetired()
      if (!options.store.isOrcadLiveCompletionDurable(candidate)) {
        throw new Error('orcad_live_completion_profile_durability_unconfirmed')
      }
      return {
        phase: 'source-retired' as const,
        sourceRetirement: 'complete' as const,
        cutover: candidate,
        receipts: preparation.receipts
      }
    }
  )
}
