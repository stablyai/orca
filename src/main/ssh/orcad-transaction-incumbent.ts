/** The incumbent slot across a journaled activation or rollback: stop it, then put it back. */
import type { OrcadActivationLockControl } from './orcad-activation-lock'
import type { OrcadSnapshotVerdict } from './orcad-activation-transaction'
import { orcadStopFreedTheHost } from './orcad-remote-process-control'
import { withoutAbortSignal } from './orcad-remote-runtime-control'
import {
  launchOrcadSlot,
  stopOrcadSlot,
  ORCAD_SLOT_STOP_WAIT_SECONDS,
  type OrcadSlotIdentity,
  type OrcadSlotOptions
} from './orcad-recovery-slot'
import { recoverOrcadIncumbent } from './orcad-incumbent-recovery'
import { errorMessage } from '../../shared/error-message'

/** Null once the incumbent provably exited; otherwise why not, with the fence kept if it may still change. */
export async function stopTransactionIncumbent(
  options: OrcadSlotOptions,
  incumbent: OrcadSlotIdentity,
  lock: OrcadActivationLockControl
): Promise<string | null> {
  const stopped = await stopOrcadSlot(options, incumbent.remoteDir, false)
  if (orcadStopFreedTheHost(stopped)) {
    return null
  }
  // Only a stop that may have been delivered can still change the host; otherwise nothing happened.
  if (stopped === 'still-running' || stopped === 'unconfirmed') {
    lock.retain()
  }
  return (
    `Could not verify that orcad ${incumbent.version} exited within ` +
    `${ORCAD_SLOT_STOP_WAIT_SECONDS}s (${stopped}).`
  )
}

export async function restartAfterSnapshotFailure(
  options: OrcadSlotOptions,
  incumbent: OrcadSlotIdentity,
  lock: OrcadActivationLockControl
): Promise<string> {
  try {
    await launchOrcadSlot(withoutAbortSignal(options), incumbent)
    lock.recovered()
    return `orcad ${incumbent.version} was restarted and is serving again.`
  } catch (error) {
    lock.retain()
    return `restarting orcad ${incumbent.version} failed: ${errorMessage(error)} This host requires recovery.`
  }
}

/**
 * Restores `restoreState` when it was replaced, then restarts the incumbent; both slots are
 * already proven exited. Null on success; otherwise why not, with the fence kept.
 */
export async function putTransactionIncumbentBack(
  options: OrcadSlotOptions,
  lock: OrcadActivationLockControl,
  input: {
    transactionStartedAt: string
    launchedVersion: string | null
    incumbent: OrcadSlotIdentity | null
    restoreState: OrcadSnapshotVerdict | null
    launchedFromState?: OrcadSnapshotVerdict | null
  }
): Promise<string | null> {
  try {
    const recovery = await recoverOrcadIncumbent(withoutAbortSignal(options), {
      ...input,
      slotsProvenExited: true
    })
    if (recovery.outcome === 'refused') {
      lock.retain()
      return recovery.reason
    }
    lock.recovered()
    return null
  } catch (error) {
    lock.retain()
    return `Restoring the previous version failed: ${errorMessage(error)} This host requires recovery.`
  }
}

/** Stop the build this run launched, then put the incumbent back only on safe state. */
export async function restoreAfterRejectedCandidate(
  options: OrcadSlotOptions,
  lock: OrcadActivationLockControl,
  input: {
    launchedDir: string
    launchedVersion: string
    transactionStartedAt: string
    incumbent: OrcadSlotIdentity | null
    restoreState: OrcadSnapshotVerdict | null
    launchedFromState?: OrcadSnapshotVerdict | null
  }
): Promise<string> {
  const { launchedDir, ...restore } = input
  const stopped = await stopOrcadSlot(withoutAbortSignal(options), launchedDir, true).catch(
    (error: unknown) => `unverifiable: ${errorMessage(error)}`
  )
  if (stopped !== 'stopped' && stopped !== 'already-exited') {
    lock.retain()
    return (
      `orcad ${input.launchedVersion} could not be confirmed stopped (${stopped}), so nothing ` +
      'was restored over state it may still own. This host requires recovery.'
    )
  }
  const failure = await putTransactionIncumbentBack(options, lock, restore)
  return (
    failure ??
    (input.incumbent
      ? `orcad ${input.incumbent.version} was restarted and is serving again.`
      : 'No previous version was active, so this host is now serving nothing.')
  )
}
