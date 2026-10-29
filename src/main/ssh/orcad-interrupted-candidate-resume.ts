/** Resume through the original readiness gate before undoing: the candidate may already serve changed state, and stopping it could require operator consent before anything can serve again. */
import type { ServeReadiness } from '../server/serve-readiness'
import { withActivatedVersion } from '../managed-server/activation/orcad-activation-record'
import { writeOrcadActivationRecord } from '../managed-server/activation/orcad-activation-record-store'
import type { OrcadActivateTransaction } from '../managed-server/activation/orcad-activation-transaction'
import { writeOrcadActivationTransaction } from '../managed-server/activation/orcad-activation-transaction-store'
import { withOrcadActivationCandidateReady } from '../managed-server/activation/orcad-activation-transaction-transitions'
import { OrcadActiveReadinessError } from './orcad-active-readiness'
import { orcadLivenessProvenExited } from '../managed-server/install/orcad-remote-launch'
import {
  ORCAD_RECOVERY_CHANGED_STATE_CODE,
  type OrcadManagedRefusal
} from '../../shared/orcad-managed-runtime'
import {
  ensureOrcadSlotServing,
  orcadSlotDir,
  resolveOrcadSlotIdentity,
  slotLiveness
} from './orcad-recovery-slot'
import type { OrcadIncumbentRecoveryOptions } from './orcad-incumbent-recovery'

/** Under the held fence, return null for undo; a refusal leaves the host untouched for an operator. */
export async function resumeInterruptedOrcadCandidate(
  options: OrcadIncumbentRecoveryOptions,
  transaction: OrcadActivateTransaction
): Promise<ServeReadiness | OrcadManagedRefusal | null> {
  const snapshotState = transaction.snapshot.state
  const incumbent = transaction.recordBefore.active
  if (
    transaction.phase !== 'snapshot-captured' ||
    snapshotState === 'pending' ||
    // A serving incumbent holds the port and instance lock; undo keeps it.
    (incumbent !== null &&
      !orcadLivenessProvenExited(await slotLiveness(options, orcadSlotDir(options, incumbent))))
  ) {
    return null
  }
  const candidate = await resolveOrcadSlotIdentity(options, transaction.candidateVersion)
  const candidateLiveness = await slotLiveness(options, candidate.remoteDir)
  // Old journals lack candidate app version, so commit would drop downgrade protection; undo a possibly serving candidate only with consent.
  if (transaction.candidateAppVersion === undefined) {
    if (orcadLivenessProvenExited(candidateLiveness) || options.acceptChangedState) {
      return null
    }
    if (candidateLiveness === 'UNKNOWN') {
      throw new Error(`Could not tell whether orcad ${transaction.candidateVersion} is running.`)
    }
    return {
      outcome: 'refused',
      verdict: 'live',
      code: ORCAD_RECOVERY_CHANGED_STATE_CODE,
      reason:
        `An older Orca left version ${transaction.candidateVersion} running without finishing ` +
        'its update, and did not record which app started it, so it was neither committed nor ' +
        'stopped. Recover to stop it, restore the prelaunch snapshot and restart the previous ' +
        'build; what it changed is discarded.'
    }
  }
  // Undo must rule out an unprovable candidate before starting another slot.
  if (candidateLiveness === 'UNKNOWN') {
    return null
  }
  let readiness: ServeReadiness
  try {
    readiness = await ensureOrcadSlotServing(options, candidate)
  } catch (error) {
    // Only candidate evidence permits undo; unanswered hosts retain the fence.
    if (error instanceof OrcadActiveReadinessError && error.verdict !== 'unverifiable') {
      return null
    }
    throw error
  }
  const now = new Date()
  const recordAfter = withActivatedVersion(
    transaction.recordBefore,
    transaction.candidateVersion,
    snapshotState === 'captured'
      ? {
          dirName: transaction.snapshot.dirName,
          takenBeforeVersion: transaction.candidateVersion,
          readableByVersion: incumbent,
          takenAt: transaction.startedAt
        }
      : null,
    now,
    transaction.candidateAppVersion ?? undefined
  )
  await writeOrcadActivationTransaction(
    options,
    withOrcadActivationCandidateReady(transaction, recordAfter, now)
  )
  await writeOrcadActivationRecord(options, recordAfter)
  return readiness
}
