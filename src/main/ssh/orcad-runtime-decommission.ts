/**
 * Stopping a managed orcad and unlinking it, on T6-4's journaled decommission. The server stays
 * linked — its SSH claim, tunnel and deployment record — unless the host proves orcad exited.
 */
import type {
  OrcadManagedCancelStopResult,
  OrcadManagedForgetResult,
  OrcadManagedStopResult
} from '../../shared/orcad-managed-runtime'
import type { OrcadDaemonRetirementVerdict } from '../../shared/orcad-stop-request'
import { removeManagedOrcadEnvironment } from '../../shared/runtime-environment-managed-orcad-store'
import type {
  KnownRuntimeEnvironment,
  OrcadDeploymentLink
} from '../../shared/runtime-environments'
import { recoverInterruptedOrcadActivation } from './orcad-activation-recovery'
import { withStaleOrcadActivationRecoveryLock } from './orcad-activation-lock'
import { readOrcadActivationTransaction } from './orcad-activation-transaction-store'
import { reconcileOrcadDecommission } from './orcad-decommission-recovery'
import { cancelRemoteOrcadManagedStop } from './orcad-managed-remote-stop'
import {
  managedOrcadSlot,
  requireManagedOrcadInfrastructure,
  resolveLinkedOrcadContext
} from './orcad-managed-runtime-context'
import { closeOrcadManagedTunnel, ensureOrcadManagedTunnel } from './orcad-managed-tunnel'
import { clearManagedOrcadUpdateDeferral } from './orcad-managed-update-deferrals'
import { removeOrcadMigrationJournalsForDestination } from './orcad-migration-cutover-journal'
import { decommissionRemoteOrcad } from './orcad-remote-decommission'
import { withManagedOrcadLifecycle } from './orcad-runtime-maintenance'
import { collectManagedTerminalCensus } from './orcad-terminal-census-client'
import { RemoteInstallLockBusyError } from './ssh-relay-install-lock'

export type ManagedOrcadStopPolicy = {
  isActiveEnvironment: (environmentId: string) => boolean
  /** Invalidates the server's transport and retires its client-side state once it is unlinked. */
  retireLocalState: (environmentId: string) => Promise<void> | void
}

type Refusal = Extract<OrcadManagedStopResult, { outcome: 'refused' }>
type Stopped = { version: string | null; retirement: OrcadDaemonRetirementVerdict | null }

function refuse(verdict: Refusal['verdict'], code: string, reason: string): Refusal {
  return { outcome: 'refused', verdict, code, reason }
}

export function stopManagedOrcadEnvironment(
  userDataPath: string,
  args: { selector: string; signal?: AbortSignal },
  policy: ManagedOrcadStopPolicy
): Promise<OrcadManagedStopResult> {
  return withManagedOrcadLifecycle(userDataPath, args.selector, async (managed) => {
    const { environment, deployment } = managed
    if (policy.isActiveEnvironment(environment.id)) {
      return refuse(
        'live',
        'orcad_stop_active_environment',
        'Choose another Active Server in Advanced before stopping this server.'
      )
    }
    const stopped = await stopRemote(userDataPath, environment, deployment, args.signal)
    if ('outcome' in stopped) {
      return stopped
    }
    await unlinkEnvironmentLocally(userDataPath, environment, deployment, policy)
    return {
      outcome: 'unlinked',
      verdict: 'exited',
      environmentId: environment.id,
      sshTargetId: deployment.sshTargetId,
      stoppedVersion: stopped.version,
      retirement: stopped.retirement
    }
  })
}

/**
 * Stop's local half alone, for a host that can no longer answer (P1-E). Nothing on the host is
 * touched or assumed: a server still running there keeps running, and a later connect relinks it.
 */
export function forgetManagedOrcadEnvironment(
  userDataPath: string,
  args: { selector: string },
  policy: ManagedOrcadStopPolicy
): Promise<OrcadManagedForgetResult> {
  return withManagedOrcadLifecycle(userDataPath, args.selector, async (managed) => {
    const { environment, deployment } = managed
    if (policy.isActiveEnvironment(environment.id)) {
      return refuse(
        'live',
        'orcad_forget_active_environment',
        'Choose another Active Server in Advanced before forgetting this server.'
      )
    }
    await unlinkEnvironmentLocally(userDataPath, environment, deployment, policy)
    return {
      outcome: 'forgotten',
      verdict: 'unverifiable',
      environmentId: environment.id,
      sshTargetId: deployment.sshTargetId
    }
  })
}

/** Proven exit, or the refusal that keeps the server linked. */
async function stopRemote(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  deployment: OrcadDeploymentLink,
  signal?: AbortSignal,
  retried = false
): Promise<Stopped | Refusal> {
  const context = await resolveLinkedOrcadContext(environment, deployment, signal)
  const slot = managedOrcadSlot(context, deployment.remotePort, signal)
  const transaction = await readOrcadActivationTransaction(slot)
  if (transaction?.operation === 'decommission') {
    // An earlier stop was interrupted: its journal decides, so finish exactly that one.
    const recovered = await recoverInterruptedOrcadActivation(slot)
    if (recovered.outcome === 'recovered' && recovered.activeVersion === null) {
      return { version: transaction.activeVersion, retirement: null }
    }
    if (recovered.outcome === 'refused') {
      return refuse(recovered.verdict, recovered.code, recovered.reason)
    }
    if (recovered.outcome === 'pending') {
      return refuse('unverifiable', recovered.code, recovered.reason)
    }
    // Another run settled the journal first; start over from what it left, never assume live.
    if (recovered.outcome === 'none') {
      return retried
        ? refuse(
            'unverifiable',
            'orcad_stop_journal_changed',
            'Another run on this server changed its stop while this one waited. Refresh and retry.'
          )
        : stopRemote(userDataPath, environment, deployment, signal, true)
    }
    return refuse(
      'live',
      'orcad_stop_withdrawn',
      'The interrupted stop was withdrawn and the server keeps serving. Stop it again.'
    )
  }
  if (transaction) {
    return refuse(
      'unverifiable',
      'orcad_activation_recovery_required',
      'An earlier update on this server was interrupted. Recover it before stopping.'
    )
  }
  const record = context.activationRecord
  if (!record.active) {
    // Only a proven exit (or a deploy that never activated) leaves the record without a version.
    return { version: null, retirement: null }
  }
  const census = await collectManagedTerminalCensus(userDataPath, environment, record)
  const result = await decommissionRemoteOrcad({ ...slot, record, census })
  if (result.outcome === 'refused') {
    return refuse(result.verdict, result.code, result.reason)
  }
  return { version: result.version, retirement: result.retirement }
}

async function unlinkEnvironmentLocally(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  deployment: OrcadDeploymentLink,
  policy: ManagedOrcadStopPolicy
): Promise<void> {
  // Environment first: a crash before the claim is released leaves a hidden target to resume,
  // never a linked server whose SSH target was already handed back.
  removeManagedOrcadEnvironment(userDataPath, environment.id)
  await policy.retireLocalState(environment.id)
  await closeOrcadManagedTunnel(environment.id)
  const { claims } = requireManagedOrcadInfrastructure()
  claims.release(deployment.sshTargetId, environment.id)
  clearManagedOrcadUpdateDeferral(environment.id)
  await claims.flush()
  // After the fence: a crash between leaves a stale journal a later conversion clears.
  removeOrcadMigrationJournalsForDestination(userDataPath, deployment.sshTargetId, environment.id)
}

/** Withdraws a stop orcad has not acted on yet; the server then keeps serving. */
export function cancelManagedOrcadStop(
  userDataPath: string,
  args: { selector: string; signal?: AbortSignal }
): Promise<OrcadManagedCancelStopResult> {
  return withManagedOrcadLifecycle(userDataPath, args.selector, async (managed) => {
    const { environment, deployment } = managed
    const context = await resolveLinkedOrcadContext(environment, deployment, args.signal)
    const slot = managedOrcadSlot(context, deployment.remotePort, args.signal)
    let result: OrcadManagedCancelStopResult
    try {
      result = await withStaleOrcadActivationRecoveryLock(slot, async (lock) => {
        const transaction = await readOrcadActivationTransaction(slot)
        if (transaction?.operation !== 'decommission') {
          if (transaction) {
            lock.retain()
          }
          return { outcome: 'none' }
        }
        if (transaction.phase === 'process-exited') {
          lock.retain()
          return { outcome: 'already-stopped' }
        }
        if (transaction.request) {
          const cancellation = await cancelRemoteOrcadManagedStop(slot, transaction.request)
          if (cancellation.outcome !== 'canceled') {
            lock.retain()
            return {
              outcome: 'refused',
              verdict: 'live',
              code: 'orcad_stop_already_dispatched',
              reason: 'orcad already acted on the stop and is shutting down; it cannot be canceled.'
            }
          }
        }
        const kept = await reconcileOrcadDecommission(slot, {
          action: 'keep-serving',
          version: transaction.activeVersion
        })
        if (kept.outcome !== 'recovered' || !kept.activeVersion) {
          lock.retain()
          return {
            outcome: 'refused',
            verdict: 'unverifiable',
            code: 'orcad_stop_cancel_unverifiable',
            reason: 'The stop was withdrawn but the server could not be shown to be serving.'
          }
        }
        return { outcome: 'canceled', activeVersion: kept.activeVersion }
      })
    } catch (error) {
      if (error instanceof RemoteInstallLockBusyError) {
        return {
          outcome: 'refused',
          verdict: 'unverifiable',
          code: 'orcad_stop_still_running',
          reason: 'A stop on this server may still be running. Retry after it settles.'
        }
      }
      throw error
    }
    if (result.outcome === 'canceled') {
      await ensureOrcadManagedTunnel(userDataPath, environment.id)
    }
    return result
  })
}
