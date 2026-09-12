import { resumeOrcadLiveDestination } from './orcad-live-destination-coordinator'
import { installOrcadLiveSourceProfile } from './orcad-live-source-profile-installation'
import { cleanupOrcadLiveSourceRuntime } from './orcad-live-source-runtime-cleanup'
import { inspectOrcadLiveRetirementRecovery } from './orcad-live-retirement-recovery-inspection'
import { inspectOrcadLiveCutoverRecovery } from './orcad-live-cutover-recovery-inspection'
import { reflushOrcadLiveRuntimeCleanupCheckpoint } from './orcad-live-runtime-cleanup-resume'
import { retireOrcadLiveSourceDeliveries } from './orcad-live-source-delivery-retirement'
import { prepareOrcadLiveSourceCompletion } from './orcad-live-source-completion'
import { retireOrcadLiveSourceRoutes } from './orcad-live-source-route-retirement'
import { completeOrcadLiveMigration } from './orcad-live-migration-completion'
import { completeOrcadLiveSuccessorMigration } from './orcad-live-successor-migration-completion'
import { selectOrcadLiveResumeAuthority } from './orcad-live-resume-authority-selection'
import { resumeOrcadLiveSuccessorMigration } from './orcad-live-successor-migration-resume'

/** Each stage reacquires authority; only the final durable journal acknowledges completion. */
export async function resumeOrcadLiveMigration(
  options: Parameters<typeof resumeOrcadLiveDestination>[0] &
    Parameters<typeof cleanupOrcadLiveSourceRuntime>[0] &
    Parameters<typeof reflushOrcadLiveRuntimeCleanupCheckpoint>[0] & { recoveryOnly?: boolean }
) {
  options.signal.throwIfAborted()
  const retirement = inspectOrcadLiveRetirementRecovery(
    options.profileDirectory,
    options.store
  ).find((entry) => entry.record.release.cutover.manifest.migrationId === options.migrationId)
  if (retirement?.state === 'conflict') {
    throw new Error('orcad_live_profile_installation_conflict')
  }
  if (retirement?.state === 'profile-installed' && retirement.completedCutover) {
    switch (retirement.completedCutover.sourceCompletion?.version) {
      case 1:
        return completeOrcadLiveMigration(options)
      case 2:
        return completeOrcadLiveSuccessorMigration(options)
    }
  }
  const retained = inspectOrcadLiveCutoverRecovery(options.profileDirectory, options.store).find(
    (entry) => entry.intent.manifest.migrationId === options.migrationId
  )
  if (!retained?.journal) {
    throw new Error('orcad_live_cutover_phase_observation_required')
  }
  const authority = selectOrcadLiveResumeAuthority(options.profileDirectory, retained.intent)
  authority.assertCurrent()
  if (authority.mode === 'successor') {
    return resumeOrcadLiveSuccessorMigration(options)
  }
  if (retirement?.state !== 'profile-installed') {
    if (retained.journal.phase !== 'destination-committed') {
      await resumeOrcadLiveDestination(options)
      options.signal.throwIfAborted()
    }
    await installOrcadLiveSourceProfile(options)
    options.signal.throwIfAborted()
  }
  const checkpoint =
    retirement?.state === 'profile-installed' && retirement.runtimeCleanupRecorded
      ? await reflushOrcadLiveRuntimeCleanupCheckpoint(options)
      : await cleanupOrcadLiveSourceRuntime(options)
  options.signal.throwIfAborted()
  const retired = await retireOrcadLiveSourceDeliveries(options)
  options.signal.throwIfAborted()
  const completionPreparation = await prepareOrcadLiveSourceCompletion(options)
  options.signal.throwIfAborted()
  const routes = await retireOrcadLiveSourceRoutes(options)
  options.signal.throwIfAborted()
  const completed = await completeOrcadLiveMigration(options)
  options.signal.throwIfAborted()
  return {
    ...completed,
    checkpoint,
    completionPreparation,
    routeCheckpoint: routes.checkpoint,
    completionEvidence: routes.completionEvidence,
    receipts: retired.receipts
  }
}
