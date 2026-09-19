import type { Store } from '../persistence'
import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { inspectOrcadLiveCutoverRecovery } from './orcad-live-cutover-recovery-inspection'
import {
  withOutgoingOrcadAuthority,
  withOutgoingOrcadSuccessorAuthority
} from './orcad-outgoing-authority'
import { validateOrcadLiveCompletedRecovery } from './orcad-live-completed-recovery'
import { assertOrcadLiveCompletedCutover } from './orcad-live-completed-cutover'
import { readOrcadLiveSourceCompletionEvidence } from './orcad-live-source-completion-evidence'
import { readOrcadLiveSuccessorCompletionEvidence } from './orcad-live-successor-completion-records'
import { OrcadLiveSourceRetirementRecordStore } from './orcad-live-source-retirement-record'

type CommittedProfileOptions = {
  profileDirectory: string
  store: Pick<Store, 'getSshTarget' | 'listOrcadMigrationSourceCutovers'>
  migrationId: string
  signal: AbortSignal
  allowCompleted?: boolean
}
type CommittedProfileContext = {
  intent: OrcadMigrationSourceCutover
  cutover: OrcadMigrationSourceCutover
  pairingCode: string
  assertAuthority: () => void
  transitionCompletedJournal: (candidate: unknown, write: () => void) => void
}

/** Journal-based authority remains valid after source profile leases are removed. */
export function withOrcadCommittedProfileAuthority<T>(
  options: CommittedProfileOptions,
  operation: (context: CommittedProfileContext) => Promise<T>
): Promise<T> {
  return withCommittedProfileAuthority(options, operation, 'original')
}

/** Completed successor admission is explicit and cannot borrow the original owner's evidence. */
export function withOrcadCommittedSuccessorProfileAuthority<T>(
  options: CommittedProfileOptions,
  operation: (context: CommittedProfileContext) => Promise<T>
): Promise<T> {
  return withCommittedProfileAuthority(options, operation, 'successor')
}

async function withCommittedProfileAuthority<T>(
  options: CommittedProfileOptions,
  operation: (context: CommittedProfileContext) => Promise<T>,
  admission: 'original' | 'successor'
): Promise<T> {
  options.signal.throwIfAborted()
  const inspect = () =>
    inspectOrcadLiveCutoverRecovery(options.profileDirectory, options.store).find(
      (entry) => entry.intent.manifest.migrationId === options.migrationId
    )
  const initial = inspect()
  if (
    !initial?.journal ||
    (initial.journal.phase !== 'destination-committed' &&
      !(options.allowCompleted && initial.journal.phase === 'source-retired'))
  ) {
    throw new Error('orcad_live_profile_installation_commit_required')
  }
  const { intent, journal } = initial
  if (
    journal.phase === 'source-retired' &&
    journal.sourceCompletion?.version !== (admission === 'original' ? 1 : 2)
  ) {
    throw new Error('orcad_live_completion_authority_version_mismatch')
  }
  const cutover =
    journal.phase === 'source-retired'
      ? validateOrcadLiveCompletedRecovery(options.profileDirectory, journal).record.release.cutover
      : journal
  let expectedEvidence = serializeOrcadMigrationValue({ intent, cutover: journal })
  const withAuthority =
    admission === 'original' ? withOutgoingOrcadAuthority : withOutgoingOrcadSuccessorAuthority
  return withAuthority(
    options.profileDirectory,
    {
      binding: {
        version: 1,
        identity: intent.liveTerminalBindings![0].identity,
        destinationEnvironmentId: intent.destinationEnvironmentId,
        sourceSshTargetId: intent.manifest.source.sshTargetId,
        sourceSshTargetGeneration: intent.manifest.source.sshTargetGeneration
      },
      sourceCutoverMigrationId: options.migrationId,
      signal: options.signal,
      assertEvidence: () => {
        const current = inspect()
        if (
          serializeOrcadMigrationValue({ intent: current?.intent, cutover: current?.journal }) !==
          expectedEvidence
        ) {
          throw new Error('orcad_live_profile_installation_journal_changed')
        }
      }
    },
    async (authority) => {
      authority.assertSourceCutoverOwner('fenced')
      let active = true
      const assertAuthority = () => {
        if (!active) {
          throw new Error('orcad_live_profile_authority_released')
        }
        authority.assertAuthority()
      }
      const transitionCompletedJournal = (candidate: unknown, write: () => void) => {
        if (!active || !options.allowCompleted) {
          throw new Error('orcad_live_completion_transition_not_enabled')
        }
        authority.assertAuthority()
        let completionEvidence
        if (admission === 'successor') {
          const record = new OrcadLiveSourceRetirementRecordStore(options.profileDirectory).read(
            cutover.liveTerminalBindings![0].identity
          )
          if (
            !record ||
            serializeOrcadMigrationValue(record.release.cutover) !==
              serializeOrcadMigrationValue(cutover)
          ) {
            throw new Error('orcad_live_successor_completion_record_required')
          }
          completionEvidence = readOrcadLiveSuccessorCompletionEvidence(
            options.profileDirectory,
            record
          )
        } else {
          completionEvidence = readOrcadLiveSourceCompletionEvidence(
            options.profileDirectory,
            cutover
          )
        }
        const completed = assertOrcadLiveCompletedCutover({
          committed: cutover,
          completed: candidate,
          completionEvidence
        })
        const current = inspect()!.journal!
        if (
          current.phase === 'source-retired' &&
          serializeOrcadMigrationValue(current) !== serializeOrcadMigrationValue(completed)
        ) {
          throw new Error('orcad_live_completion_transition_conflict')
        }
        write()
        expectedEvidence = serializeOrcadMigrationValue({ intent, cutover: completed })
        authority.assertAuthority()
      }
      try {
        assertAuthority()
        const result = await operation({
          ...authority,
          intent,
          cutover,
          assertAuthority,
          transitionCompletedJournal
        })
        assertAuthority()
        return result
      } finally {
        active = false
      }
    }
  )
}
