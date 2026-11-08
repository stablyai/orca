import type { OrcadActivationLockControl } from '../managed-server/activation/orcad-activation-lock'
import type { OrcadSnapshotVerdict } from '../managed-server/activation/orcad-activation-transaction'
import { orcadStopFreedTheHost } from '../managed-server/install/orcad-remote-process-control'
import { withoutAbortSignal } from '../managed-server/install/orcad-remote-runtime-control'
import {
  launchOrcadSlot,
  stopOrcadSlot,
  ORCAD_SLOT_STOP_WAIT_SECONDS,
  type OrcadSlotIdentity,
  type OrcadSlotOptions
} from './orcad-recovery-slot'
import { recoverOrcadIncumbent } from './orcad-incumbent-recovery'
import { errorMessage } from '../../shared/error-message'

/** Return null on proven exit; otherwise retain the fence when a delivered stop may still change the host. */
export async function stopTransactionIncumbent(
  options: OrcadSlotOptions,
  incumbent: OrcadSlotIdentity,
  lock: OrcadActivationLockControl
): Promise<{ reason: string; stopMayBeUnderway: boolean } | null> {
  const stopped = await stopOrcadSlot(options, incumbent.remoteDir, false)
  if (orcadStopFreedTheHost(stopped)) {
    return null
  }
  // Only a stop that may have been delivered can still change the host; otherwise nothing happened.
  const stopMayBeUnderway = stopped === 'still-running' || stopped === 'unconfirmed'
  if (stopMayBeUnderway) {
    lock.retain()
  }
  return {
    reason:
      `Could not verify that orcad ${incumbent.version} exited within ` +
      `${ORCAD_SLOT_STOP_WAIT_SECONDS}s (${stopped}).`,
    stopMayBeUnderway
  }
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

/** Restore changed state and incumbent only after both slots prove exit; refusal retains the fence. */
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

/** Stop the rejected candidate before safely restoring incumbent state. */
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
