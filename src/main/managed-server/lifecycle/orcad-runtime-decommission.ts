// Keep claims, tunnels and registration until the host proves server exit.
import type {
  OrcadManagedCancelStopResult,
  OrcadManagedForgetResult,
  OrcadManagedStopResult
} from '../../../shared/orcad-managed-runtime'
import type { OrcadDaemonRetirementVerdict } from '../../../shared/orcad-stop-request'
import { removeManagedOrcadEnvironment } from '../../../shared/remote-runtime/host-store/runtime-environment-managed-orcad-store'
import { listEnvironments } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import { findManagedSshTwin } from '../../../shared/remote-runtime/host-catalog/runtime-environment-host-key-match'
import type {
  KnownRuntimeEnvironment,
  OrcadSshDeploymentLink
} from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import { recoverInterruptedOrcadActivation } from '../activation/orcad-activation-recovery'
import { withStaleOrcadActivationRecoveryLock } from '../activation/orcad-activation-lock'
import { readOrcadActivationTransaction } from '../activation/orcad-activation-transaction-store'
import { reconcileOrcadDecommission } from './orcad-decommission-recovery'
import { cancelRemoteOrcadManagedStop } from './orcad-managed-remote-stop'
import {
  managedOrcadSlot,
  requireManagedOrcadInfrastructure,
  resolveLinkedOrcadContext
} from './orcad-managed-runtime-context'
import { closeOrcadManagedTunnel, ensureOrcadManagedTunnel } from './orcad-managed-tunnel'
import { clearManagedOrcadUpdateDeferral } from './orcad-managed-update-deferrals'
import { removeOrcadMigrationJournalsForDestination } from '../../persistence/migrating-orcad-catalog/cutover-journals/orcad-migration-cutover-journal'
import { decommissionRemoteOrcad } from '../install/orcad-remote-decommission'
import { withManagedOrcadLifecycle } from './orcad-managed-lifecycle'
import { collectManagedTerminalCensus } from './orcad-terminal-census-client'
import { RemoteInstallLockBusyError } from '../install/remote-install-lock'

type ManagedOrcadStopPolicy = {
  isActiveEnvironment: (environmentId: string) => boolean
  retireLocalState: (environmentId: string) => Promise<void> | void
  /** Runs inside the host's lifecycle, so a Connect queued behind the unlink still wins. */
  releaseHostTransport: (sshTargetId: string) => Promise<void>
}

type Refusal = Extract<OrcadManagedStopResult, { outcome: 'refused' }>
type Stopped = { version: string | null; retirement: OrcadDaemonRetirementVerdict | null }

function refuse(verdict: Refusal['verdict'], code: string, reason: string): Refusal {
  return { outcome: 'refused', verdict, code, reason }
}

export async function stopManagedOrcadEnvironment(
  userDataPath: string,
  args: { selector: string; signal?: AbortSignal },
  policy: ManagedOrcadStopPolicy
): Promise<OrcadManagedStopResult> {
  return await withManagedOrcadLifecycle(userDataPath, args.selector, async (managed) => {
    const { environment, deployment } = managed
    if (policy.isActiveEnvironment(environment.id)) {
      return refuse(
        'live',
        'orcad_stop_active_environment',
        'This server is the default host for new projects. Choose another one under New projects open on before stopping it.'
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

/** Forget local state without assuming host exit; later connects may relink a still-running server. */
export async function forgetManagedOrcadEnvironment(
  userDataPath: string,
  args: { selector: string },
  policy: ManagedOrcadStopPolicy
): Promise<OrcadManagedForgetResult> {
  return await withManagedOrcadLifecycle(userDataPath, args.selector, (managed) =>
    forgetLinkedEnvironment(userDataPath, managed, policy)
  )
}

/** Forget one of two saved entries for one managed server; the other keeps managing it, so the host is not contacted. */
export async function forgetRedundantManagedOrcadEnvironment(
  userDataPath: string,
  args: { selector: string },
  policy: ManagedOrcadStopPolicy
): Promise<OrcadManagedForgetResult> {
  return await withManagedOrcadLifecycle(userDataPath, args.selector, async (managed) => {
    // Checked in the queue and unlinked in the same tick, so two Removes cannot each count the other as the twin.
    if (!findManagedSshTwin(await listEnvironments(userDataPath), managed.environment)) {
      return refuse(
        'live',
        'orcad_forget_no_managed_twin',
        'No other saved entry manages this server anymore, so removing this one would leave it unmanaged. Stop it instead.'
      )
    }
    return forgetLinkedEnvironment(userDataPath, managed, policy)
  })
}

async function forgetLinkedEnvironment(
  userDataPath: string,
  {
    environment,
    deployment
  }: { environment: KnownRuntimeEnvironment; deployment: OrcadSshDeploymentLink },
  policy: ManagedOrcadStopPolicy
): Promise<OrcadManagedForgetResult> {
  if (policy.isActiveEnvironment(environment.id)) {
    return refuse(
      'live',
      'orcad_forget_active_environment',
      'This server is the default host for new projects. Choose another one under New projects open on before forgetting it.'
    )
  }
  await unlinkEnvironmentLocally(userDataPath, environment, deployment, policy)
  return {
    outcome: 'forgotten',
    verdict: 'unverifiable',
    environmentId: environment.id,
    sshTargetId: deployment.sshTargetId
  }
}

async function stopRemote(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  deployment: OrcadSshDeploymentLink,
  signal?: AbortSignal,
  retried = false
): Promise<Stopped | Refusal> {
  const context = await resolveLinkedOrcadContext(environment, deployment, signal)
  const slot = managedOrcadSlot(context, deployment.remotePort, signal)
  const transaction = await readOrcadActivationTransaction(slot)
  if (transaction?.operation === 'decommission') {
    // Resume the exact interrupted stop from its journal.
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
    // Another run may settle recovery first; restart from its resulting record.
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
  deployment: OrcadSshDeploymentLink,
  policy: ManagedOrcadStopPolicy
): Promise<void> {
  // Remove registration before releasing claims so crashes leave a resumable hidden target.
  await removeManagedOrcadEnvironment(userDataPath, environment.id)
  await policy.retireLocalState(environment.id)
  await closeOrcadManagedTunnel(environment.id)
  const { claims } = requireManagedOrcadInfrastructure()
  claims.releaseForUserRemoval(deployment.sshTargetId, environment.id)
  clearManagedOrcadUpdateDeferral(environment.id)
  await claims.flush()
  // Clear journals after the fence; stale leftovers are recoverable on later conversion.
  removeOrcadMigrationJournalsForDestination(userDataPath, deployment.sshTargetId, environment.id)
  // No server serves the host now, and an unserved host never stays connected.
  await policy.releaseHostTransport(deployment.sshTargetId)
}

export async function cancelManagedOrcadStop(
  userDataPath: string,
  args: { selector: string; signal?: AbortSignal }
): Promise<OrcadManagedCancelStopResult> {
  return await withManagedOrcadLifecycle(userDataPath, args.selector, async (managed) => {
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
