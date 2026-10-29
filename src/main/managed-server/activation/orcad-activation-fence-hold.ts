/** Retry live fences later, clear abandoned bare fences, and require recovery for interrupted journaled state. */
import {
  orcadActivationFenceExists,
  withStaleOrcadActivationRecoveryLock,
  type OrcadActivationLockOptions
} from './orcad-activation-lock'
import { readOrcadActivationTransaction } from './orcad-activation-transaction-store'
import { orcadActivationFenceLockDir } from './orcad-activation-transaction'
import { isRelayInstallLockStale } from '../install/remote-install-lock'
import { findExitedOwnLockToken } from '../../ssh/orcad-exited-own-lock'
import { orcadRemoteBaseDir } from '../install/orcad-remote-windows-node'

export const ORCAD_ACTIVATION_FENCE_BUSY_CODE = 'orcad_activation_fence_busy'
const ORCAD_ACTIVATION_RECOVERY_REQUIRED_CODE = 'orcad_activation_recovery_required'

type OrcadActivationFenceRefusal = {
  code: string
  reason: string
  /** Bare stale fence cleared; the caller may retry immediately. */
  cleared?: true
}

export async function orcadActivationFenceRefusal(
  options: OrcadActivationLockOptions,
  attempt: string
): Promise<OrcadActivationFenceRefusal> {
  const lockDir = orcadActivationFenceLockDir(options.host, options.remoteHome)
  const journal = (await readOrcadActivationTransaction(options).catch(() => null)) !== null
  const baseDir = orcadRemoteBaseDir(options.host, options.remoteHome)
  const stale =
    (await findExitedOwnLockToken(options, lockDir, { baseDir, guardsStateMutation: true })) !==
      null || (await isRelayInstallLockStale(options.conn, lockDir, options.host))
  if (stale && !journal && (await clearAbandonedFence(options))) {
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
        reason: `Another run is changing this host’s Orca server, so the ${attempt} did not start. It is retried on a later connect.`
      }
}

/** Drop a stale fence only after rechecking under takeover that no journal appeared. */
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
    // Failed takeover leaves the fence intact for normal refusal classification.
    return false
  }
}
