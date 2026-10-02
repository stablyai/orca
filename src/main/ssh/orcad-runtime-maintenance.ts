/**
 * Updating, rolling back and recovering a managed orcad, on T6-2's deploy, rollback and recovery.
 * Every step reads the terminal census through the server's tunnel first; an unanswered census
 * is unverifiable, never zero, so an update over live or uncounted terminals defers (D7).
 */
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
import { readRemoteOrcadBuildHash } from './orcad-remote-build-hash'
import { deployOrcad } from './orcad-remote-deploy'
import { rollbackOrcad } from './orcad-remote-rollback'
import { collectManagedTerminalCensus } from './orcad-terminal-census-client'
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
  return withManagedOrcadLifecycle(
    userDataPath,
    args.selector,
    async ({ environment, deployment }) => {
      const context = await resolveLinkedOrcadContext(environment, deployment, args.signal)
      const census = await collectManagedTerminalCensus(
        userDataPath,
        environment,
        context.activationRecord
      )
      const localOrcadDir = await materializeOrcadArtifact(context.serverTarget, {
        signal: args.signal
      })
      const result = await deployOrcad({
        ...managedOrcadSlot(context, deployment.remotePort, args.signal),
        localOrcadDir,
        target: context.serverTarget,
        census,
        force: args.force
      })
      if (result.outcome === 'installed-not-activated') {
        const deferral = {
          outcome: 'deferred' as const,
          candidateVersion: result.fullVersion,
          code: result.code,
          reason: result.reason,
          forceable: isForceableOrcadDeferral(result.code)
        }
        recordManagedOrcadUpdateDeferral(environment.id, deferral)
        return deferral
      }
      clearManagedOrcadUpdateDeferral(environment.id)
      const readiness = await probeManagedOrcadReadiness(
        context,
        localOrcadDir,
        result.fullVersion,
        args.signal
      )
      const updated = refreshPairing(userDataPath, environment, readiness, deployment.localPort)
      return {
        outcome: result.outcome === 'already-active' ? 'already-current' : 'updated',
        environment: redactRuntimeEnvironment(updated),
        activeVersion: result.fullVersion
      }
    }
  )
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
      const census = await collectManagedTerminalCensus(userDataPath, environment, record)
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
  args: LifecycleArgs
): Promise<OrcadManagedRecoveryResult> {
  return withManagedOrcadLifecycle(
    userDataPath,
    args.selector,
    async ({ environment, deployment }) => {
      const context = await resolveLinkedOrcadContext(environment, deployment, args.signal)
      const result = await recoverInterruptedOrcadActivation(
        managedOrcadSlot(context, deployment.remotePort, args.signal)
      )
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
