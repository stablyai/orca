/**
 * Deploys orcad onto an empty SSH host and pairs this client with it through a loopback tunnel.
 * The target claim is the resume point: an interrupted deploy leaves the target owned by the
 * environment id it was creating, and the next deploy of that target finishes the same one.
 */
import { randomUUID } from 'node:crypto'
import { assertRuntimeEnvironmentNotReconciling } from '../../shared/runtime-environment-reconciliation-record'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { addManagedOrcadEnvironment } from '../../shared/runtime-environment-managed-orcad-store'
import { redactRuntimeEnvironment } from '../../shared/runtime-environments'
import {
  ORCAD_MANAGED_REMOTE_PORT,
  type OrcadManagedDeployResult
} from '../../shared/orcad-managed-runtime'
import { getManagedOrcadOwnerEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import { runTargetLifecycle } from '../ipc/ssh-target-lifecycle-queue'
import { materializeOrcadArtifact } from './orcad-artifact-materializer'
import {
  closeOrcadManagedTunnel,
  ensureOrcadManagedTunnel,
  startOrcadManagedTunnel
} from './orcad-managed-tunnel'
import { recoverInterruptedOrcadActivation } from './orcad-activation-recovery'
import { readOrcadActivationRecord } from './orcad-activation-record-store'
import { resolveOrcadRemoteContext } from './orcad-remote-context'
import { deployOrcad } from './orcad-remote-deploy'
import { tunneledOrcadPairingCode } from './orcad-tunneled-pairing'
import { hasRegisteredDirectSshAuthority } from './ssh-target-registry'
import {
  isForceableOrcadDeferral,
  MANAGED_ORCAD_LEGACY_NODE_PATH,
  ORCAD_BIND_HOST,
  probeManagedOrcadReadiness,
  requireManagedOrcadInfrastructure
} from './orcad-managed-runtime-context'

export async function createManagedOrcadEnvironment(
  userDataPath: string,
  args: { name: string; sshTargetId: string; force?: boolean; signal?: AbortSignal }
): Promise<OrcadManagedDeployResult> {
  return runTargetLifecycle(args.sshTargetId, async () => {
    const { connectionManager, targetStore, claims } = requireManagedOrcadInfrastructure()
    const environmentId =
      getManagedOrcadOwnerEnvironmentId(targetStore.getTarget(args.sshTargetId)?.owner) ??
      randomUUID()
    const environments = listEnvironments(userDataPath)
    const registered = environments.find((entry) => entry.id === environmentId)
    if (registered) {
      assertRuntimeEnvironmentNotReconciling(registered)
      if (registered.orcadDeployment?.sshTargetId !== args.sshTargetId) {
        throw new Error('The SSH target is owned by a server that is not deployed on it.')
      }
    }
    if (environments.some((entry) => entry.id !== environmentId && entry.name === args.name)) {
      throw new Error(`A server named "${args.name}" already exists.`)
    }
    if (hasRegisteredDirectSshAuthority(args.sshTargetId)) {
      throw new Error('Disconnect this SSH host before converting it to a managed Orca server.')
    }
    const claimed = claims.claim(args.sshTargetId, environmentId, args.name)
    await claims.flush(args.signal)
    const targetGeneration = claimed.generation
    if (targetGeneration === undefined) {
      throw new Error('The managed Orca SSH registration has no durable generation.')
    }
    if (registered && registered.orcadDeployment?.sshTargetGeneration !== targetGeneration) {
      throw new Error('The saved managed Orca server has a stale SSH target generation.')
    }
    let environmentRegistered = false
    try {
      const connection = await connectionManager.connect(claimed)
      let context = await resolveOrcadRemoteContext(claimed, connection, args.signal)
      const slot = {
        conn: context.connection,
        host: context.host,
        remoteHome: context.remoteHome,
        nodePath: MANAGED_ORCAD_LEGACY_NODE_PATH,
        userDataDir: context.userDataDir,
        bindHost: ORCAD_BIND_HOST,
        port: ORCAD_MANAGED_REMOTE_PORT,
        signal: args.signal
      }
      const recovery = await recoverInterruptedOrcadActivation(slot)
      if (recovery.outcome === 'pending' || recovery.outcome === 'refused') {
        throw new Error(recovery.reason)
      }
      if (recovery.outcome === 'recovered') {
        context = { ...context, activationRecord: await readOrcadActivationRecord(slot) }
      }
      if (registered) {
        environmentRegistered = true
        await ensureOrcadManagedTunnel(userDataPath, registered.id)
        const activeVersion = context.activationRecord.active
        if (!activeVersion) {
          throw new Error('The managed Orca server has no active runtime version.')
        }
        return {
          outcome: 'already-current',
          environment: redactRuntimeEnvironment(registered),
          activeVersion
        }
      }
      const localOrcadDir = await materializeOrcadArtifact(context.serverTarget, {
        signal: args.signal
      })
      const deployResult = await deployOrcad({
        ...slot,
        conn: connection,
        localOrcadDir,
        target: context.serverTarget,
        // Why unknown when a version is active: only the daemon can count its sessions, and
        // a deploy that guessed zero would restart over live terminals.
        census: context.activationRecord.active
          ? { liveSessions: null, startedSinceActivation: null, daemonProtocolVersion: null }
          : { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: null },
        force: args.force
      })
      if (deployResult.outcome === 'installed-not-activated') {
        return {
          outcome: 'deferred',
          candidateVersion: deployResult.fullVersion,
          code: deployResult.code,
          reason: deployResult.reason,
          forceable: isForceableOrcadDeferral(deployResult.code)
        }
      }
      const readiness = await probeManagedOrcadReadiness(
        context,
        localOrcadDir,
        deployResult.fullVersion,
        args.signal
      )
      const localPort = await startOrcadManagedTunnel(
        environmentId,
        claimed,
        connection,
        ORCAD_MANAGED_REMOTE_PORT
      )
      const environment = addManagedOrcadEnvironment(userDataPath, {
        id: environmentId,
        name: args.name,
        pairingCode: tunneledOrcadPairingCode(readiness, localPort),
        orcadDeployment: {
          sshTargetId: claimed.id,
          sshTargetGeneration: targetGeneration,
          localPort,
          remotePort: ORCAD_MANAGED_REMOTE_PORT
        }
      })
      environmentRegistered = true
      return {
        outcome: deployResult.outcome === 'already-active' ? 'already-current' : 'created',
        environment: redactRuntimeEnvironment(environment),
        activeVersion: deployResult.fullVersion
      }
    } finally {
      if (!environmentRegistered) {
        await closeOrcadManagedTunnel(environmentId).catch(() => undefined)
      }
    }
  })
}
