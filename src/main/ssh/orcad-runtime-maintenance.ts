/**
 * Updating, rolling back and recovering a managed orcad, on T6-2's deploy, rollback and recovery.
 * Every step reads the terminal census through the server's tunnel first; an unanswered census
 * is unverifiable, never zero, so an update over live or uncounted terminals defers (D7).
 */
import { getAppEnvironment } from '../../shared/app-environment'
import { refreshManagedOrcadPairing } from '../../shared/runtime-environment-managed-orcad-store'
import { assertRuntimeEnvironmentNotReconciling } from '../../shared/runtime-environment-reconciliation-record'
import {
  redactRuntimeEnvironment,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import type {
  OrcadManagedDeployResult,
  OrcadManagedRecoveryResult,
  OrcadManagedRollbackResult
} from '../../shared/orcad-managed-runtime'
import { runTargetLifecycle } from '../ipc/ssh-target-lifecycle-queue'
import type { ServeReadiness } from '../server/serve-readiness'
import { recoverInterruptedOrcadActivation } from './orcad-activation-recovery'
import { probeActiveOrcadReadiness } from './orcad-active-readiness'
import { materializeOrcadArtifact } from './orcad-artifact-materializer'
import { CURRENT_ORCAD_DAEMON_PROTOCOL } from './orcad-daemon-protocol-crossing'
import { ensureOrcadManagedTunnel } from './orcad-managed-tunnel'
import {
  clearManagedOrcadUpdateDeferral,
  recordManagedOrcadUpdateDeferral
} from './orcad-managed-update-deferrals'
import {
  isForceableOrcadDeferral,
  managedOrcadInstallDir,
  managedOrcadSlot,
  probeManagedOrcadReadiness,
  requireManagedOrcadEnvironment,
  resolveLinkedOrcadContext
} from './orcad-managed-runtime-context'
import type { OrcadRemoteContext } from './orcad-remote-context'
import { readRemoteOrcadBuildHash } from './orcad-remote-build-hash'
import { deployOrcad, type OrcadDeployOptions } from './orcad-remote-deploy'
import { ORCAD_ACTIVATION_POLICY_REFUSED_CODE } from './orcad-installed-activation'
import { pruneManagedOrcadVersions } from './orcad-managed-version-gc'
import { rollbackOrcad } from './orcad-remote-rollback'
import { collectManagedTerminalCensus } from './orcad-terminal-census-client'
import { findIncompleteManagedOrcadMigration } from './orcad-managed-migration-status'
import { latestOrcadMigrationInto } from './orcad-migration-rollback-mark'
import { tunneledOrcadPairingCode } from './orcad-tunneled-pairing'

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

function refreshPairing(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  readiness: ServeReadiness,
  localPort: number
): KnownRuntimeEnvironment {
  return refreshManagedOrcadPairing(
    userDataPath,
    environment.id,
    tunneledOrcadPairingCode(readiness, localPort)
  )
}

export function updateManagedOrcadEnvironment(
  userDataPath: string,
  args: LifecycleArgs & { force?: boolean }
): Promise<OrcadManagedDeployResult> {
  return withManagedOrcadLifecycle(userDataPath, args.selector, async (managed) =>
    runManagedOrcadUpdate(
      userDataPath,
      managed,
      await resolveLinkedOrcadContext(managed.environment, managed.deployment, args.signal),
      args
    )
  )
}

/** The Managed servers update, run inside the target's lifecycle queue with a resolved context. */
export async function runManagedOrcadUpdate(
  userDataPath: string,
  { environment, deployment }: ReturnType<typeof requireManagedOrcadEnvironment>,
  context: OrcadRemoteContext,
  args: {
    force?: boolean
    signal?: AbortSignal
    localOrcadDir?: string
    admitRecord?: OrcadDeployOptions['admitRecord']
  }
): Promise<OrcadManagedDeployResult> {
  // Why release: finished automation shells would otherwise defer every update on a host with
  // schedules; the update restarts the server anyway.
  const census = await collectManagedTerminalCensus(
    userDataPath,
    environment,
    context.activationRecord,
    undefined,
    { releaseFinishedAutomationTerminals: true }
  )
  const localOrcadDir =
    args.localOrcadDir ??
    (await materializeOrcadArtifact(context.serverTarget, { signal: args.signal }))
  const slot = managedOrcadSlot(context, deployment.remotePort, args.signal)
  const result = await deployOrcad({
    ...slot,
    localOrcadDir,
    target: context.serverTarget,
    census,
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
      forceable: isForceableOrcadDeferral(result.code)
    }
    // A policy refusal is a decision about this host, not an update waiting to be retried.
    if (result.code !== ORCAD_ACTIVATION_POLICY_REFUSED_CODE) {
      recordManagedOrcadUpdateDeferral(environment.id, deferral)
    }
    return deferral
  }
  clearManagedOrcadUpdateDeferral(environment.id)
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
  const updated = refreshPairing(userDataPath, environment, readiness, deployment.localPort)
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
      const census = await collectManagedTerminalCensus(
        userDataPath,
        environment,
        record,
        undefined,
        {
          releaseFinishedAutomationTerminals: true
        }
      )
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
      const slot = managedOrcadSlot(context, deployment.remotePort, args.signal)
      const targetDir = managedOrcadInstallDir(context, target)
      const targetBuildHash = await readRemoteOrcadBuildHash(slot, targetDir)
      const result = await rollbackOrcad({
        ...slot,
        record,
        census,
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
      const updated = refreshPairing(userDataPath, environment, readiness, deployment.localPort)
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
        ? refreshPairing(userDataPath, environment, result.readiness, deployment.localPort)
        : environment
      if (result.activeVersion) {
        await ensureOrcadManagedTunnel(userDataPath, environment.id)
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
