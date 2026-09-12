import { parseOrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import { OrcadLiveSourceRetirementRecordStore } from './orcad-live-source-retirement-record'
import { readOrcadLiveSourceCompletionEvidence } from './orcad-live-source-completion-evidence'
import { assertOrcadLiveCompletedCutover } from './orcad-live-completed-cutover'
import { readOrcadLiveSuccessorCompletionEvidence } from './orcad-live-successor-completion-records'

/** Completed journal references must resolve to the full retained evidence chain. */
export function validateOrcadLiveCompletedRecovery(profileDirectory: string, value: unknown) {
  const journal = parseOrcadMigrationSourceCutover(value)
  if (journal.version !== 2 || journal.phase !== 'source-retired' || !journal.sourceCompletion) {
    throw new Error('orcad_live_completed_recovery_journal_required')
  }
  const records = new OrcadLiveSourceRetirementRecordStore(profileDirectory)
    .list()
    .filter((record) => record.sha256 === journal.sourceCompletion!.retirementRecordSha256)
  if (records.length !== 1) {
    throw new Error('orcad_live_completed_recovery_record_required')
  }
  const record = records[0]
  const completionEvidence =
    journal.sourceCompletion.version === 2
      ? readOrcadLiveSuccessorCompletionEvidence(profileDirectory, record)
      : readOrcadLiveSourceCompletionEvidence(profileDirectory, record.release.cutover)
  const completed = assertOrcadLiveCompletedCutover({
    committed: record.release.cutover,
    completed: journal,
    completionEvidence
  })
  return { record, completed }
}
