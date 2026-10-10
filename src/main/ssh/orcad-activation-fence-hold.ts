/**
 * Why a fence answered "held": a run that is still working clears on its own and is retried on
 * a later connect. A stale fence with no journal is cleared here, since Recover would only drop it.
 * Only a stale lock over a journal, or a journal no fence guards, needs Recover: a live run
 * journals under a fresh fence too, and Recover cannot take a fresh fence anyway.
 */
import {
  orcadActivationFenceExists,
  withStaleOrcadActivationRecoveryLock,
  type OrcadActivationLockOptions
} from './orcad-activation-lock'
import { readOrcadActivationTransaction } from './orcad-activation-transaction-store'
import { orcadActivationFenceLockDir } from './orcad-activation-transaction'
import { isRelayInstallLockStale } from './ssh-relay-install-lock'
import { findExitedOwnLockToken } from './orcad-exited-own-lock'
import { orcadRemoteBaseDir } from './orcad-remote-windows-node'

export const ORCAD_ACTIVATION_FENCE_BUSY_CODE = 'orcad_activation_fence_busy'
const ORCAD_ACTIVATION_RECOVERY_REQUIRED_CODE = 'orcad_activation_recovery_required'

type OrcadActivationFenceRefusal = {
  code: string
  reason: string
  /** A stale fence no journal backed was cleared, so the attempt may run again at once. */
  cleared?: true
}

export async function orcadActivationFenceRefusal(
  options: OrcadActivationLockOptions,
  attempt: string
): Promise<OrcadActivationFenceRefusal> {
  const lockDir = orcadActivationFenceLockDir(options.host, options.remoteHome)
  // An unreadable answer reads as busy: retrying later is never wrong, a sticky failure can be.
  const journal = (await readOrcadActivationTransaction(options).catch(() => null)) !== null
  const baseDir = orcadRemoteBaseDir(options.host, options.remoteHome)
  const stale =
    (await findExitedOwnLockToken(options, lockDir, { baseDir, guardsStateMutation: true })) !==
      null || (await isRelayInstallLockStale(options.conn, lockDir, options.host))
  if (stale && !journal && (await clearAbandonedFence(options))) {
    // A wake or release cut short leaves a bare fence; Recover would only drop it (BUG-21).
    return {
      code: ORCAD_ACTIVATION_FENCE_BUSY_CODE,
      reason: `An abandoned fence held this host and was cleared; the ${attempt} is retried.`,
      cleared: true
    }
  }
  const stuck = stale || (journal && !(await orcadActivationFenceExists(options).catch(() => true)))
  return stuck
    ? {
        code: ORCAD_ACTIVATION_RECOVERY_REQUIRED_CODE,
        reason: `An interrupted update or stop holds this host, so the ${attempt} did not start. Recover it first.`
      }
    : {
        code: ORCAD_ACTIVATION_FENCE_BUSY_CODE,
        reason: `Another run is changing this host's managed server, so the ${attempt} did not start. It is retried on a later connect.`
      }
}

/** Takes the stale fence over and drops it, unless a journal appeared under it meanwhile. */
async function clearAbandonedFence(options: OrcadActivationLockOptions): Promise<boolean> {
  try {
    return await withStaleOrcadActivationRecoveryLock(options, async (lock) => {
      if (await readOrcadActivationTransaction(options)) {
        lock.retain()
        return false
      }
      return true
    })
  } catch {
    // Another client took it first, or the host did not answer: classify as before.
    return false
  }
}
