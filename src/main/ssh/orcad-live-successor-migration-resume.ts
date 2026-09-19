import { inspectOrcadLiveCutoverRecovery } from './orcad-live-cutover-recovery-inspection'
import { inspectOrcadLiveRetirementRecovery } from './orcad-live-retirement-recovery-inspection'
import { selectOrcadLiveResumeAuthority } from './orcad-live-resume-authority-selection'
import { bindOrcadLiveCancellationCohort } from './orcad-live-cancellation-cohort'
import { retireOrcadLiveSuccessorSourceDeliveries } from './orcad-live-successor-source-retirement'
import { installOrcadLiveSuccessorSourceProfile } from './orcad-live-successor-profile-installation'
import { prepareOrcadLiveSuccessorCompletion } from './orcad-live-successor-route-preparation'
import { completeOrcadLiveSuccessorMigration } from './orcad-live-successor-migration-completion'

/** Each stage reacquires successor authority; profile removal forbids resuming source ownership. */
export async function resumeOrcadLiveSuccessorMigration(
  options: Parameters<typeof installOrcadLiveSuccessorSourceProfile>[0] &
    Parameters<typeof completeOrcadLiveSuccessorMigration>[0] & {
      store: Parameters<typeof inspectOrcadLiveRetirementRecovery>[1]
      recoveryOnly?: boolean
    }
) {
  options.signal.throwIfAborted()
  const retained = inspectOrcadLiveCutoverRecovery(options.profileDirectory, options.store).find(
    (entry) => entry.intent.manifest.migrationId === options.migrationId
  )
  if (retained?.journal?.phase !== 'destination-committed') {
    throw new Error('orcad_live_successor_commit_required')
  }
  const authority = selectOrcadLiveResumeAuthority(options.profileDirectory, retained.intent)
  if (authority.mode !== 'successor') {
    throw new Error('orcad_live_successor_resume_authority_required')
  }
  const assertCurrent = () => {
    options.signal.throwIfAborted()
    authority.assertCurrent()
  }
  assertCurrent()
  const retirement = inspectOrcadLiveRetirementRecovery(
    options.profileDirectory,
    options.store
  ).find((entry) => entry.record.release.cutover.manifest.migrationId === options.migrationId)
  if (!retirement || retirement.state === 'conflict') {
    throw new Error('orcad_live_successor_retirement_record_required')
  }
  assertCurrent()
  if (retirement.state === 'profile-installed') {
    bindOrcadLiveCancellationCohort(options.profileDirectory, retirement.record).assertCancellation(
      retirement.record
    )
  } else {
    await retireOrcadLiveSuccessorSourceDeliveries({
      ...options,
      recoveryOnly: options.recoveryOnly ?? false
    })
  }
  assertCurrent()
  await installOrcadLiveSuccessorSourceProfile(options)
  assertCurrent()
  const prepared = await prepareOrcadLiveSuccessorCompletion(options)
  assertCurrent()
  const completed = await completeOrcadLiveSuccessorMigration(options)
  assertCurrent()
  return {
    ...completed,
    completionPreparation: prepared.preparation,
    routeCheckpoint: prepared.checkpoint
  }
}
