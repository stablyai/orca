import type { SshManagedServerUpdateNote, SshTarget } from '../../shared/ssh-types'
import type { ManagedOrcadAutoUpdateOutcome } from '../managed-server/lifecycle/orcad-managed-auto-update'
import type { HostServerUpdateReason } from './ssh-host-server-connect-events'
import { ORCAD_ACTIVATION_FENCE_BUSY_CODE } from '../managed-server/activation/orcad-activation-fence-hold'

export type ManagedServerUpdateDeps = {
  autoUpdate: (
    environmentId: string,
    options: { failedBefore: () => boolean; onUpdating: () => void }
  ) => Promise<ManagedOrcadAutoUpdateOutcome>
  /** A failure for this app version suppresses retries within the same launch. */
  recordedUpdateFailure: (target: SshTarget) => string | null
  /** True once an update failed on this host during this app launch; a restart retries once. */
  failedThisLaunch: (target: SshTarget) => boolean
  recordUpdateFailure: (target: SshTarget, reason: string) => void
  clearUpdateFailure: (target: SshTarget) => void
}

export type HostServerUpdateOnConnect = {
  note: SshManagedServerUpdateNote | undefined
  /** Recheck soon when another desktop's update holds the fence. */
  fenceBusy?: true
  reason: HostServerUpdateReason
  /** True when a recorded failure for this app version skipped the update without a try. */
  recorded: boolean
}

/** Update failure must leave the host serving and cannot fail the caller. */
export async function checkManagedServerUpdate(
  target: SshTarget,
  environmentId: string,
  deps: ManagedServerUpdateDeps,
  onUpdating: () => void
): Promise<HostServerUpdateOnConnect> {
  let result: ManagedOrcadAutoUpdateOutcome
  try {
    result = await deps.autoUpdate(environmentId, {
      // Read under the lock: overlapping checks may record failure while this one waits.
      failedBefore: () =>
        deps.recordedUpdateFailure(target) !== null && deps.failedThisLaunch(target),
      onUpdating
    })
  } catch (error) {
    console.warn('[ssh] Could not check the managed Orca server for an update:', error)
    return {
      note: {
        state: 'check-failed',
        detail: error instanceof Error ? error.message : String(error)
      },
      reason: 'update_check_failed',
      recorded: false
    }
  }
  // An overlapping update may have landed this build or recorded failure while the check waited.
  if (
    deps.recordedUpdateFailure(target) !== null &&
    (result.outcome === 'updated' || (result.outcome === 'skipped' && result.reason === 'current'))
  ) {
    deps.clearUpdateFailure(target)
  }
  switch (result.outcome) {
    case 'updated':
      return { note: undefined, reason: 'updated', recorded: false }
    case 'deferred':
      return {
        note: { state: 'deferred', detail: result.reason },
        reason: 'update_deferred',
        recorded: false,
        ...(result.code === ORCAD_ACTIVATION_FENCE_BUSY_CODE ? { fenceBusy: true as const } : {})
      }
    case 'failed':
      deps.recordUpdateFailure(target, result.reason)
      return {
        note: { state: 'failed', detail: result.reason },
        reason: 'update_failed',
        recorded: false
      }
    case 'skipped':
      return skipped(result.reason, deps.recordedUpdateFailure(target))
  }
}

function skipped(
  reason: Extract<ManagedOrcadAutoUpdateOutcome, { outcome: 'skipped' }>['reason'],
  failure: string | null
): HostServerUpdateOnConnect {
  switch (reason) {
    case 'host-newer':
      return { note: { state: 'host-newer' }, reason: 'update_host_newer', recorded: false }
    // Re-offering a just-rolled-back build would make the host flap.
    case 'rolled-back':
      return { note: { state: 'rolled-back' }, reason: 'update_rolled_back', recorded: false }
    case 'failed-before':
      return {
        note: failure ? { state: 'failed', detail: failure } : undefined,
        reason: 'update_failed',
        recorded: true
      }
    case 'no-template':
    case 'migrating':
      return { note: { state: reason }, reason: 'connected', recorded: false }
    case 'current':
      return { note: undefined, reason: 'connected', recorded: false }
  }
}
