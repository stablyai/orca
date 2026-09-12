import { updateEnvironmentFromPairingCode } from '../../shared/runtime-environment-store'
import { assertRuntimeEnvironmentNotReconciling } from '../../shared/runtime-environment-reconciliation-record'
import { redactRuntimeEnvironment } from '../../shared/runtime-environments'
import type {
  OrcadManagedDeployResult,
  OrcadManagedRecoveryResult,
  OrcadManagedRollbackResult,
  OrcadManagedRuntimeStatus
} from '../../shared/orcad-managed-runtime'
import { runTargetLifecycle } from '../ipc/ssh-target-lifecycle-queue'
import { materializeOrcadArtifact } from './orcad-artifact-materializer'
import { ensureOrcadManagedTunnel } from './orcad-managed-tunnel'
import { readRemoteOrcadBuildHash } from './orcad-remote-build-hash'
import { deployOrcad } from './orcad-remote-deploy'
import { recoverInterruptedOrcadActivation } from './orcad-activation-recovery'
import type { OrcadActivationTransaction } from './orcad-activation-transaction'
import { readOrcadActivationTransaction } from './orcad-activation-transaction-store'
import { rollbackOrcad } from './orcad-remote-rollback'
import {
  requestRemoteOrcadDecommission,
  requestRemoteOrcadManagedDecommission
} from './orcad-decommission-client'
import { resolveOrcadSlotNodeFallback } from './orcad-slot-runtime-eligibility'
import { collectRemoteOrcadTerminalCensus } from './orcad-terminal-census-client'
import { tunneledOrcadPairingCode } from './orcad-tunneled-pairing'
import { findIncompleteManagedOrcadMigration } from './orcad-managed-migration-status'
import {
  isForceableOrcadDeferral,
  managedOrcadInstallDir,
  ORCAD_BIND_HOST,
  requireManagedOrcadEnvironment,
  resolveActiveOrcadNodeFallback,
  resolveLinkedOrcadContext,
  resolveOrcadDeployReadiness
} from './orcad-managed-runtime-context'

export async function updateManagedOrcadEnvironment(
  userDataPath: string,
  args: { selector: string; force?: boolean; signal?: AbortSignal }
): Promise<OrcadManagedDeployResult> {
  const environment = requireManagedOrcadEnvironment(userDataPath, args.selector)
  const deployment = environment.orcadDeployment!
  return runTargetLifecycle(deployment.sshTargetId, async () => {
    assertRuntimeEnvironmentNotReconciling(
      requireManagedOrcadEnvironment(userDataPath, environment.id)
    )
    const context = await resolveLinkedOrcadContext(environment, args.signal)
    await ensureOrcadManagedTunnel(userDataPath, environment.id)
    const census = await collectRemoteOrcadTerminalCensus(environment, context.activationRecord)
    const localOrcadDir = await materializeOrcadArtifact(context.bunTarget, {
      signal: args.signal
    })
    const nodePath = await resolveActiveOrcadNodeFallback(context, args.signal)
    const result = await deployOrcad({
      conn: context.connection,
      host: context.host,
      remoteHome: context.remoteHome,
      localOrcadDir,
      buildTarget: context.bunTarget,
      nodePath,
      userDataDir: context.userDataDir,
      bindHost: ORCAD_BIND_HOST,
      port: deployment.remotePort,
      census,
      force: args.force,
      signal: args.signal
    })
    if (result.outcome === 'installed-not-activated') {
      return {
        outcome: 'deferred',
        candidateVersion: result.fullVersion,
        code: result.code,
        reason: result.reason,
        forceable: isForceableOrcadDeferral(result.code)
      }
    }
    const readiness = await resolveOrcadDeployReadiness(
      context,
      localOrcadDir,
      result,
      nodePath,
      deployment.remotePort,
      args.signal
    )
    const updated = updateEnvironmentFromPairingCode(userDataPath, environment.id, {
      pairingCode: tunneledOrcadPairingCode(readiness, deployment.localPort)
    })
    return {
      outcome: result.outcome === 'already-active' ? 'already-current' : 'updated',
      environment: redactRuntimeEnvironment(updated),
      activeVersion: result.fullVersion
    }
  })
}

export async function getManagedOrcadRuntimeStatus(
  userDataPath: string,
  selector: string,
  signal?: AbortSignal
): Promise<OrcadManagedRuntimeStatus> {
  const environment = requireManagedOrcadEnvironment(userDataPath, selector)
  return runTargetLifecycle(environment.orcadDeployment!.sshTargetId, async () => {
    const context = await resolveLinkedOrcadContext(environment, signal)
    const record = context.activationRecord
    const transaction = await readOrcadActivationTransaction({
      conn: context.connection,
      host: context.host,
      remoteHome: context.remoteHome,
      signal
    })
    const migration = findIncompleteManagedOrcadMigration(environment)
    return {
      environmentId: environment.id,
      sshTargetId: context.target.id,
      activeVersion: record.active,
      previousVersion: record.previous,
      activatedAt: record.activatedAt,
      rollbackAvailable: Boolean(record.previous && record.snapshot),
      migration: migration ? { phase: migration.phase, startedAt: migration.startedAt } : null,
      recovery: transaction ? managedRecoveryStatus(transaction) : null
    }
  })
}

function managedRecoveryStatus(
  transaction: OrcadActivationTransaction
): NonNullable<OrcadManagedRuntimeStatus['recovery']> {
  switch (transaction.operation) {
    case 'activate':
      return {
        operation: transaction.operation,
        phase: transaction.phase,
        version: transaction.candidateVersion,
        startedAt: transaction.startedAt
      }
    case 'rollback':
      return {
        operation: transaction.operation,
        phase: transaction.phase,
        version: transaction.targetVersion,
        startedAt: transaction.startedAt
      }
    case 'decommission':
      return {
        operation: transaction.operation,
        phase: transaction.phase,
        version: transaction.activeVersion,
        startedAt: transaction.startedAt
      }
  }
}

export async function recoverManagedOrcadEnvironment(
  userDataPath: string,
  args: { selector: string; signal?: AbortSignal },
  policy: { isActiveEnvironment: (environmentId: string) => boolean }
): Promise<OrcadManagedRecoveryResult> {
  const environment = requireManagedOrcadEnvironment(userDataPath, args.selector)
  const deployment = environment.orcadDeployment!
  const assertDecommissionAllowed = () => {
    assertRuntimeEnvironmentNotReconciling(
      requireManagedOrcadEnvironment(userDataPath, environment.id)
    )
    if (policy.isActiveEnvironment(environment.id)) {
      throw new Error('Choose another Active Server in Advanced before retrying this stop.')
    }
  }
  return runTargetLifecycle(deployment.sshTargetId, async () => {
    assertRuntimeEnvironmentNotReconciling(
      requireManagedOrcadEnvironment(userDataPath, environment.id)
    )
    const context = await resolveLinkedOrcadContext(environment, args.signal)
    const result = await recoverInterruptedOrcadActivation({
      assertDecommissionAllowed,
      conn: context.connection,
      host: context.host,
      remoteHome: context.remoteHome,
      userDataDir: context.userDataDir,
      bindHost: ORCAD_BIND_HOST,
      port: deployment.remotePort,
      requestDecommission: (activeVersion, transactionId) => {
        assertDecommissionAllowed()
        return requestRemoteOrcadDecommission(environment, activeVersion, transactionId)
      },
      requestManagedDecommission: async (version, authority) => {
        await ensureOrcadManagedTunnel(userDataPath, environment.id)
        assertDecommissionAllowed()
        return requestRemoteOrcadManagedDecommission(environment, version, authority)
      },
      signal: args.signal
    })
    if (result.outcome !== 'recovered') {
      return result
    }
    const updated = result.readiness
      ? updateEnvironmentFromPairingCode(userDataPath, environment.id, {
          pairingCode: tunneledOrcadPairingCode(result.readiness, deployment.localPort)
        })
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
  })
}

export async function rollbackManagedOrcadEnvironment(
  userDataPath: string,
  args: { selector: string; signal?: AbortSignal }
): Promise<OrcadManagedRollbackResult> {
  const environment = requireManagedOrcadEnvironment(userDataPath, args.selector)
  const deployment = environment.orcadDeployment!
  return runTargetLifecycle(deployment.sshTargetId, async () => {
    assertRuntimeEnvironmentNotReconciling(
      requireManagedOrcadEnvironment(userDataPath, environment.id)
    )
    const context = await resolveLinkedOrcadContext(environment, args.signal)
    await ensureOrcadManagedTunnel(userDataPath, environment.id)
    const census = await collectRemoteOrcadTerminalCensus(environment, context.activationRecord)
    const targetVersion = context.activationRecord.previous
    let nodePath: string | undefined
    let targetBuildHash = ''
    if (targetVersion) {
      const targetDir = managedOrcadInstallDir(context, targetVersion)
      nodePath = await resolveOrcadSlotNodeFallback(
        context.connection,
        context.host,
        targetDir,
        args.signal
      )
      targetBuildHash = await readRemoteOrcadBuildHash({
        conn: context.connection,
        host: context.host,
        remoteInstallDir: targetDir,
        signal: args.signal
      })
    }
    const result = await rollbackOrcad({
      conn: context.connection,
      host: context.host,
      remoteHome: context.remoteHome,
      record: context.activationRecord,
      nodePath,
      userDataDir: context.userDataDir,
      bindHost: ORCAD_BIND_HOST,
      port: deployment.remotePort,
      census,
      targetBuildHash,
      signal: args.signal
    })
    if (result.outcome !== 'rolled-back') {
      return result
    }
    const updated = updateEnvironmentFromPairingCode(userDataPath, environment.id, {
      pairingCode: tunneledOrcadPairingCode(result.readiness, deployment.localPort)
    })
    return {
      outcome: 'rolled-back',
      environment: redactRuntimeEnvironment(updated),
      activeVersion: result.target,
      discarded: result.discarded
    }
  })
}
