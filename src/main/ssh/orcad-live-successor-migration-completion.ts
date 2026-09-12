import type { Store } from '../persistence'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { withOrcadLiveSuccessorReadiness } from './orcad-live-successor-readiness'
import {
  assertOrcadLiveCompletedCutover,
  createOrcadLiveCompletedCutover
} from './orcad-live-completed-cutover'
import {
  bindOrcadLiveSuccessorRouteCheckpoint,
  OrcadLiveSuccessorCompletionPreparationStore,
  OrcadLiveSuccessorRouteCheckpointStore,
  readOrcadLiveSuccessorCompletionEvidence
} from './orcad-live-successor-completion-records'
import { OrcadLiveSourceCancellationReceiptStore } from './orcad-live-source-cancellation-receipt'
import { OrcadLiveCoveredCancellationReceiptStore } from './orcad-live-covered-cancellation-receipt'
import { OrcadLiveAppliedCoverageEvidenceStore } from './orcad-live-applied-coverage-evidence'
import {
  assertOutgoingSshPtyRoutesAbsent,
  restoreRetiredOutgoingSshPtyRoutes
} from '../ipc/pty/provider/outgoing-source-route-retirement'

/** Successor completion acknowledges the exact journal only after a proven profile flush. */
export function completeOrcadLiveSuccessorMigration(
  options: Parameters<typeof withOrcadLiveSuccessorReadiness>[0] & {
    store: Pick<
      Store,
      | 'completeOrcadLiveRetirementProfile'
      | 'flushPendingOrThrowAsync'
      | 'isOrcadLiveCompletionDurable'
    >
    now?: () => Date
  }
) {
  return withOrcadLiveSuccessorReadiness(
    { ...options, allowCompleted: true },
    async ({ record, appliedEvidence, receipts, assertCurrent, transitionCompletedJournal }) => {
      const committed = record.release.cutover
      const targetId = committed.manifest.source.sshTargetId
      const bound = bindOrcadLiveSuccessorRouteCheckpoint(options.profileDirectory, record)
      const completionEvidence = readOrcadLiveSuccessorCompletionEvidence(
        options.profileDirectory,
        record
      )
      const expected = serializeOrcadMigrationValue(completionEvidence)
      const assertEvidence = () => {
        options.signal.throwIfAborted()
        assertCurrent()
        bound.assertCurrent()
        if (
          serializeOrcadMigrationValue(
            readOrcadLiveSuccessorCompletionEvidence(options.profileDirectory, record)
          ) !== expected
        ) {
          throw new Error('orcad_live_successor_completion_evidence_changed')
        }
        assertOutgoingSshPtyRoutesAbsent(targetId)
      }
      assertEvidence()
      const routes = restoreRetiredOutgoingSshPtyRoutes({
        targetId,
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
      const ordinary = new OrcadLiveSourceCancellationReceiptStore(options.profileDirectory)
      const covered = new OrcadLiveCoveredCancellationReceiptStore(options.profileDirectory)
      routes.assertRetired()
      for (const receipt of receipts) {
        if (receipt.version === 1) {
          ordinary.persist(receipt)
        } else {
          covered.persist(receipt)
        }
        routes.assertRetired()
      }
      new OrcadLiveAppliedCoverageEvidenceStore(options.profileDirectory).persist(appliedEvidence)
      routes.assertRetired()
      new OrcadLiveSuccessorCompletionPreparationStore(options.profileDirectory).persist(
        bound.preparation
      )
      routes.assertRetired()
      new OrcadLiveSuccessorRouteCheckpointStore(options.profileDirectory).persist(bound.checkpoint)
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
      routes.assertRetired()
      return {
        phase: 'source-retired' as const,
        sourceRetirement: 'complete' as const,
        cutover: candidate,
        receipts
      }
    }
  )
}
