import type { Store } from '../persistence'
import { OrcadLiveSourceRetirementRecordStore } from './orcad-live-source-retirement-record'
import { listValidatedOrcadLiveCleanupPreparations } from './orcad-live-source-cleanup-intent'
import { listValidatedOrcadLiveRuntimeCleanupCheckpoints } from './orcad-live-runtime-cleanup-checkpoint'
import { listValidatedOrcadLiveCleanupOutputEvidence } from './orcad-live-cleanup-output-evidence'
import { listValidatedOrcadLiveCancellationRecoveryReceipts } from './orcad-live-cancellation-recovery-receipts'
import { listValidatedOrcadLiveSourceCompletionPreparations } from './orcad-live-source-completion-preparation'
import { listValidatedOrcadLiveSourceRouteCheckpoints } from './orcad-live-source-route-checkpoint'
import { validateOrcadLiveCompletedRecovery } from './orcad-live-completed-recovery'

export function inspectOrcadLiveRetirementRecovery(
  profileDirectory: string,
  store: Pick<Store, 'listOrcadLiveRetirementMarkers' | 'inspectOrcadLiveRetirementProfileState'>
) {
  const records = new OrcadLiveSourceRetirementRecordStore(profileDirectory).list()
  const markers = store.listOrcadLiveRetirementMarkers()
  const preparations = listValidatedOrcadLiveCleanupPreparations(profileDirectory, records)
  const cleanupIntents = preparations.map(({ intent }) => intent)
  const settledOutputs = listValidatedOrcadLiveCleanupOutputEvidence(profileDirectory, preparations)
  const cancellations = listValidatedOrcadLiveCancellationRecoveryReceipts(
    profileDirectory,
    records,
    settledOutputs
  )
  const receiptCounts = new Map<string, number>()
  for (const { record } of cancellations) {
    receiptCounts.set(record.sha256, (receiptCounts.get(record.sha256) ?? 0) + 1)
  }
  const runtimeCleanups = listValidatedOrcadLiveRuntimeCleanupCheckpoints(
    profileDirectory,
    preparations
  )
  const migrations = new Set<string>()
  const completions = listValidatedOrcadLiveSourceCompletionPreparations(
    profileDirectory,
    settledOutputs,
    runtimeCleanups
  )
  const routeCheckpoints = listValidatedOrcadLiveSourceRouteCheckpoints(
    profileDirectory,
    completions
  )
  for (const record of records) {
    const inspection = store.inspectOrcadLiveRetirementProfileState(record)
    if (inspection.state === 'profile-installed' && inspection.completedCutover) {
      validateOrcadLiveCompletedRecovery(profileDirectory, inspection.completedCutover)
    }
    const migrationId = record.release.cutover.manifest.migrationId
    if (migrations.has(migrationId)) {
      throw new Error('orcad_live_retirement_recovery_record_conflict')
    }
    migrations.add(migrationId)
  }
  for (const marker of markers) {
    if (
      !records.some(
        (record) =>
          record.release.cutover.manifest.migrationId === marker.migrationId &&
          record.sha256 === marker.recordSha256
      )
    ) {
      throw new Error('orcad_live_retirement_recovery_record_missing')
    }
  }
  return records.map((record) => ({
    ...store.inspectOrcadLiveRetirementProfileState(record),
    ...(routeCheckpoints.some((entry) => entry.record.sha256 === record.sha256)
      ? { sourceRouteRemovalRecorded: true as const }
      : {}),
    ...(completions.some((entry) => entry.record.sha256 === record.sha256)
      ? { sourceCompletionPrepared: true as const }
      : {}),
    ...(receiptCounts.has(record.sha256)
      ? {
          sourceCancellationReceipts: {
            recorded: receiptCounts.get(record.sha256)!,
            total: record.release.cutover.liveTerminalBindings!.length
          }
        }
      : {}),
    ...(settledOutputs.some((entry) => entry.record.sha256 === record.sha256)
      ? { sourceOutputSettlementRecorded: true as const }
      : {}),
    ...(cleanupIntents.some((intent) => intent.retirementRecordSha256 === record.sha256)
      ? { cleanupPrepared: true as const }
      : {}),
    ...(runtimeCleanups.some((entry) => entry.record.sha256 === record.sha256)
      ? { runtimeCleanupRecorded: true as const }
      : {})
  }))
}
