/**
 * A managed host's update check, shared by the connect and the launch-time tunnel restore, turned
 * into its status note and telemetry reason.
 */
import type { SshManagedServerUpdateNote, SshTarget } from '../../shared/ssh-types'
import type { ManagedOrcadAutoUpdateOutcome } from './orcad-managed-auto-update'
import type { HostServerUpdateReason } from './ssh-host-server-connect-events'
import { ORCAD_ACTIVATION_FENCE_BUSY_CODE } from './orcad-activation-fence-hold'

export type ManagedServerUpdateDeps = {
  /** Runs the Managed servers update when the host is behind this app; `onUpdating` fires first. */
  autoUpdate: (
    environmentId: string,
    options: { failedBefore: boolean; onUpdating: () => void }
  ) => Promise<ManagedOrcadAutoUpdateOutcome>
  /** Why an update to this app version already failed on the host, so it isn't retried. */
  recordedUpdateFailure: (target: SshTarget) => string | null
  recordUpdateFailure: (target: SshTarget, reason: string) => void
  clearUpdateFailure: (target: SshTarget) => void
}

export type HostServerUpdateOnConnect = {
  note: SshManagedServerUpdateNote | undefined
  /** Deferred only because another desktop's update holds the host; worth checking again soon. */
  fenceBusy?: true
  reason: HostServerUpdateReason
  /** True when a recorded failure for this app version skipped the update without a try. */
  recorded: boolean
}

/** The host keeps serving whatever happens here, so nothing in it can fail the caller. */
export async function checkManagedServerUpdate(
  target: SshTarget,
  environmentId: string,
  deps: ManagedServerUpdateDeps,
  onUpdating: () => void
): Promise<HostServerUpdateOnConnect> {
  const failure = deps.recordedUpdateFailure(target)
  let result: ManagedOrcadAutoUpdateOutcome
  try {
    result = await deps.autoUpdate(environmentId, {
      failedBefore: failure !== null,
      onUpdating
    })
  } catch (error) {
    console.warn('[ssh] Could not check the managed Orca server for an update:', error)
    return { note: undefined, reason: 'update_check_failed', recorded: false }
  }
  // Why clear on current too: a Managed servers update may have landed the build since.
  if (
    failure !== null &&
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
      return skipped(result.reason, failure)
  }
}

function skipped(
  reason: Extract<ManagedOrcadAutoUpdateOutcome, { outcome: 'skipped' }>['reason'],
  failure: string | null
): HostServerUpdateOnConnect {
  switch (reason) {
    case 'host-newer':
      return { note: { state: 'host-newer' }, reason: 'update_host_newer', recorded: false }
    case 'rolled-back':
      return { note: undefined, reason: 'update_rolled_back', recorded: false }
    case 'failed-before':
      return {
        note: failure ? { state: 'failed', detail: failure } : undefined,
        reason: 'update_failed',
        recorded: true
      }
    case 'current':
    case 'no-template':
    case 'migrating':
      return { note: undefined, reason: 'connected', recorded: false }
  }
}
