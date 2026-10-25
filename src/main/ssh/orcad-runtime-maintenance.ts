/**
 * Updating, rolling back and recovering a managed orcad, on T6-2's deploy, rollback and recovery.
 * Every step reads the terminal census through the server's tunnel first; an unanswered census
 * is unverifiable, never zero, so an update over live or uncounted terminals defers (D7).
 */
import { getAppEnvironment } from '../../shared/app-environment'
import { assertRuntimeEnvironmentNotReconciling } from '../../shared/runtime-environment-reconciliation-record'
import {
  redactRuntimeEnvironment,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import type {
  OrcadManagedDeployResult,
  OrcadManagedPastLiveTerminals,
  OrcadManagedRecoveryResult,
  OrcadManagedRollbackResult
} from '../../shared/orcad-managed-runtime'
import { runTargetLifecycle } from '../ipc/ssh/ssh-target-lifecycle-queue'
import { recoverInterruptedOrcadActivation } from '../managed-server/activation/orcad-activation-recovery'
import { probeActiveOrcadReadiness } from './orcad-active-readiness'
import { materializeOrcadArtifact } from '../orcad/orcad-artifact-materializer'
import { CURRENT_ORCAD_DAEMON_PROTOCOL } from './orcad-daemon-protocol-crossing'
import { rebuildOrcadManagedTunnel } from '../managed-server/lifecycle/orcad-managed-tunnel'
import { wakeAlreadyActiveOrcad } from './orcad-already-active-wake'
import {
  clearManagedOrcadUpdateDeferral,
  recordManagedOrcadUpdateDeferral
} from '../managed-server/lifecycle/orcad-managed-update-deferrals'
import {
  isForceableOrcadDeferral,
  managedOrcadInstallDir,
  managedOrcadSlot,
  probeManagedOrcadReadiness,
  requireManagedOrcadEnvironment,
  resolveLinkedOrcadContext
} from '../managed-server/lifecycle/orcad-managed-runtime-context'
import type { OrcadRemoteContext } from '../managed-server/install/orcad-remote-context'
import { readRemoteOrcadBuildHash } from '../managed-server/install/orcad-remote-build-hash'
import { deployOrcad, type OrcadDeployOptions } from './orcad-remote-deploy'
import type { OrcadUpdateForce } from './orcad-update-plan'
import { ORCAD_ACTIVATION_POLICY_REFUSED_CODE } from './orcad-installed-activation'
import { pruneManagedOrcadVersions } from '../managed-server/lifecycle/orcad-managed-version-gc'
import { clearOrcadUpdateFailedThisLaunch } from '../managed-server/lifecycle/orcad-managed-update-failure-memory'
import { admitOrcadRecordForIntent } from '../managed-server/lifecycle/orcad-managed-update-decision'
import { rollbackOrcad } from '../managed-server/install/orcad-remote-rollback'
import { collectManagedTerminalCensus } from './orcad-terminal-census-client'
import { updateTerminalCounts } from './orcad-fenced-stop'
import { findIncompleteManagedOrcadMigration } from '../managed-server/lifecycle/orcad-managed-migration-status'
import { latestOrcadMigrationInto } from './orcad-migration-rollback-mark'
import { refreshMaintainedOrcadPairing } from './orcad-maintenance-pairing-refresh'

type LifecycleArgs = { selector: string; signal?: AbortSignal }

export function withManagedOrcadLifecycle<T>(
  userDataPath: string,
  selector: string,
  run: (managed: ReturnType<typeof requireManagedOrcadEnvironment>) => Promise<T>
): Promise<T> {
  const { environment, deployment } = requireManagedOrcadEnvironment(userDataPath, selector)
  return runTargetLifecycle(deployment.sshTargetId, async () => {
    // Re-read under the queue: a reconciliation or stop may have won the race for it.
    const current = requireManagedOrcadEnvironment(userDataPath, environment.id)
    assertRuntimeEnvironmentNotReconciling(current.environment)
    return run(current)
  })
}

/** A launched slot may bind another port than the forward in use, so forward anew. */
export async function followLaunchedServerPort(
  userDataPath: string,
  environmentId: string
): Promise<void> {
  try {
    await rebuildOrcadManagedTunnel(userDataPath, environmentId)
  } catch (error) {
    // Why not fail: the server already launched; a rebuild that got past its drop leaves no
    // forward, so the next connect forwards to the bound port.
    console.warn('[ssh] Could not forward to the relaunched managed Orca server:', error)
  }
}

export function updateManagedOrcadEnvironment(
  userDataPath: string,
  args: LifecycleArgs & { force?: boolean; pastLiveTerminals?: OrcadManagedPastLiveTerminals }
): Promise<OrcadManagedDeployResult> {
  const { pastLiveTerminals } = args
  // Update anyway keeps Update's version admission even if a caller also passed force.
  const intent = args.force && !pastLiveTerminals ? 'force' : 'update'
  return withManagedOrcadLifecycle(userDataPath, args.selector, async (managed) => {
    const admitIntent = admitOrcadRecordForIntent(intent, getAppEnvironment().getVersion())
    // Checked under the host fence: another desktop may have activated a build since the confirm.
    const admitRecord: NonNullable<OrcadDeployOptions['admitRecord']> = pastLiveTerminals
      ? (record, candidateVersion) =>
          record.active !== pastLiveTerminals.incumbentVersion
            ? "This host's server changed since the update was confirmed. Review it and update again."
            : admitIntent(record, candidateVersion)
      : admitIntent
    const force: OrcadUpdateForce | undefined = pastLiveTerminals ? 'live-terminals' : args.force
    const result = await runManagedOrcadUpdate(
      userDataPath,
      managed,
      await resolveLinkedOrcadContext(managed.environment, managed.deployment, args.signal),
      { signal: args.signal, force, admitRecord }
    )
    // Only a landed Update re-enables the connect's attempts; a failed retry stays remembered.
    if (result.outcome !== 'deferred') {
      clearOrcadUpdateFailedThisLaunch({ kind: 'ssh', id: managed.deployment.sshTargetId })
    }
    return result
  })
}

/** The Managed servers update, run inside the target's lifecycle queue with a resolved context. */
export async function runManagedOrcadUpdate(
  userDataPath: string,
  { environment, deployment }: ReturnType<typeof requireManagedOrcadEnvironment>,
  context: OrcadRemoteContext,
  args: {
    force?: OrcadUpdateForce
    signal?: AbortSignal
    localOrcadDir?: string
    admitRecord?: OrcadDeployOptions['admitRecord']
  }
): Promise<OrcadManagedDeployResult> {
  const { countFirst, ...recount } = updateTerminalCounts((options) =>
    collectManagedTerminalCensus(
      userDataPath,
      environment,
      context.activationRecord,
      undefined,
      options
    )
  )
  const census = await countFirst()
  const localOrcadDir =
    args.localOrcadDir ??
    (await materializeOrcadArtifact(context.serverTarget, { signal: args.signal }))
  const slot = managedOrcadSlot(context, deployment.remotePort, args.signal)
  const result = await deployOrcad({
    ...slot,
    localOrcadDir,
    target: context.serverTarget,
    census,
    ...recount,
    censusRecord: context.activationRecord,
    force: args.force,
    appVersion: getAppEnvironment().getVersion(),
    ...(args.admitRecord ? { admitRecord: args.admitRecord } : {})
  })
  if (result.outcome === 'installed-not-activated') {
    const deferral = {
      outcome: 'deferred' as const,
      candidateVersion: result.fullVersion,
      code: result.code,
      reason: result.reason,
      // A policy refusal is what Force exists to pass, e.g. over a host a newer Orca runs.
      forceable:
        isForceableOrcadDeferral(result.code) ||
        result.code === ORCAD_ACTIVATION_POLICY_REFUSED_CODE
    }
    // A policy refusal is a decision about this host, not an update waiting to be retried.
    if (result.code !== ORCAD_ACTIVATION_POLICY_REFUSED_CODE) {
      recordManagedOrcadUpdateDeferral(environment.id, deferral)
    }
    return deferral
  }
  clearManagedOrcadUpdateDeferral(environment.id)
  const started = result.outcome === 'already-active' && (await wakeAlreadyActiveOrcad(slot))
  const readiness = await probeManagedOrcadReadiness(
    context,
    localOrcadDir,
    result.fullVersion,
    args.signal
  )
  await pruneManagedOrcadVersions({
    slot,
    serverTarget: context.serverTarget,
    activeVersion: result.fullVersion,
    readiness
  })
  const updated = refreshMaintainedOrcadPairing(userDataPath, environment.id, readiness)
  if (started || result.outcome !== 'already-active') {
    await followLaunchedServerPort(userDataPath, environment.id)
  }
  return {
    outcome: result.outcome === 'already-active' ? 'already-current' : 'updated',
    environment: redactRuntimeEnvironment(updated),
    activeVersion: result.fullVersion
  }
}

export function rollbackManagedOrcadEnvironment(
  userDataPath: string,
  args: LifecycleArgs
): Promise<OrcadManagedRollbackResult> {
  return withManagedOrcadLifecycle(
    userDataPath,
    args.selector,
    async ({ environment, deployment }) => {
      const context = await resolveLinkedOrcadContext(environment, deployment, args.signal)
      const record = context.activationRecord
      const target = record.previous
      if (!target) {
        return {
          outcome: 'refused',
          code: 'orcad_rollback_no_target',
          reason: 'This server has no previous version to roll back to.'
        }
      }
      const crossing = migrationRollbackRefusal(userDataPath, environment, record.activatedAt)
      if (crossing) {
        return crossing
      }
      const slot = managedOrcadSlot(context, deployment.remotePort, args.signal)
      const targetDir = managedOrcadInstallDir(context, target)
      const targetBuildHash = await readRemoteOrcadBuildHash(slot, targetDir)
      const { countFirst, ...recount } = updateTerminalCounts((options) =>
        collectManagedTerminalCensus(userDataPath, environment, record, undefined, options)
      )
      // Unfenced: rollbackOrcad counts again under the host lock, closing admission, before the stop.
      const census = await countFirst()
      // Why idle only: this client cannot read the older build's daemon protocol, so it cannot show
      // that build would reach terminals that are still running.
      if (census.liveSessions !== 0) {
        return {
          outcome: 'refused',
          code:
            census.liveSessions === null
              ? 'orcad_rollback_census_unavailable'
              : 'orcad_rollback_terminals_running',
          reason:
            census.liveSessions === null
              ? 'The server did not answer how many terminals it runs. Retry when it answers.'
              : 'Close the terminals running on this server before rolling it back.'
        }
      }
      const result = await rollbackOrcad({
        ...slot,
        record,
        census,
        ...recount,
        targetBuildHash,
        targetDaemonProtocol: CURRENT_ORCAD_DAEMON_PROTOCOL
      })
      if (result.outcome !== 'rolled-back') {
        return result
      }
      const readiness = await probeActiveOrcadReadiness(
        { ...slot, remoteInstallDir: targetDir },
        { buildHash: targetBuildHash, fullVersion: result.target }
      )
      const updated = refreshMaintainedOrcadPairing(userDataPath, environment.id, readiness)
      await followLaunchedServerPort(userDataPath, environment.id)
      return {
        outcome: 'rolled-back',
        environment: redactRuntimeEnvironment(updated),
        activeVersion: result.target,
        discarded: result.discarded
      }
    }
  )
}

/** Finishes or undoes an interrupted activation, rollback or decommission on the host. */
export function recoverManagedOrcadEnvironment(
  userDataPath: string,
  args: LifecycleArgs & { acceptChangedState?: boolean }
): Promise<OrcadManagedRecoveryResult> {
  return withManagedOrcadLifecycle(
    userDataPath,
    args.selector,
    async ({ environment, deployment }) => {
      const context = await resolveLinkedOrcadContext(environment, deployment, args.signal)
      const result = await recoverInterruptedOrcadActivation({
        ...managedOrcadSlot(context, deployment.remotePort, args.signal),
        acceptChangedState: args.acceptChangedState === true
      })
      if (result.outcome !== 'recovered') {
        return result
      }
      const updated = result.readiness
        ? refreshMaintainedOrcadPairing(userDataPath, environment.id, result.readiness)
        : environment
      if (result.activeVersion) {
        await followLaunchedServerPort(userDataPath, environment.id)
      }
      return {
        outcome: 'recovered',
        resolution: result.resolution,
        activeVersion: result.activeVersion,
        environment: redactRuntimeEnvironment(updated)
      }
    }
  )
}

/**
 * A rollback restores the snapshot taken when the current version activated. If a migration
 * began after that, the snapshot predates the imported catalog and restoring it would drop it.
 */
function migrationRollbackRefusal(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  activatedAt: string | null
): OrcadManagedRollbackResult | null {
  if (findIncompleteManagedOrcadMigration(userDataPath, environment.id)) {
    return {
      outcome: 'refused',
      code: 'orcad_rollback_migration_in_progress',
      reason: 'A migration into this server is still running. Finish it before rolling back.'
    }
  }
  const migratedAt = latestOrcadMigrationInto(userDataPath, environment)
  if (migratedAt && (activatedAt === null || Date.parse(activatedAt) < Date.parse(migratedAt))) {
    return {
      outcome: 'refused',
      code: 'orcad_rollback_crosses_migration',
      reason:
        "The previous version's state predates the projects migrated onto this server; " +
        'rolling back would lose them. Deploy forward instead.'
    }
  }
  return null
}
