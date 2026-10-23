/**
 * Deploys orcad onto an empty SSH host and pairs this client with it through a loopback tunnel.
 * The target claim is the resume point: an interrupted deploy leaves the target owned by the
 * environment id it was creating, and the next deploy of that target finishes the same one.
 */
import { getAppEnvironment } from '../../../shared/app-environment'
import { randomUUID } from 'node:crypto'
import { assertRuntimeEnvironmentNotReconciling } from '../../../shared/runtime-environment-reconciliation-record'
import { listEnvironments } from '../../../shared/runtime-environment-store'
import { addManagedOrcadEnvironment } from '../../../shared/runtime-environment-managed-orcad-store'
import {
  getOrcadSshDeployment,
  redactRuntimeEnvironment
} from '../../../shared/runtime-environments'
import {
  ORCAD_MANAGED_REMOTE_PORT,
  type OrcadManagedDeferral,
  type OrcadManagedDeployResult
} from '../../../shared/orcad-managed-runtime'
import { getManagedOrcadFenceEnvironmentId } from '../../../shared/managed-orcad-ssh-owner'
import { runTargetLifecycle } from '../../ipc/ssh/ssh-target-lifecycle-queue'
import { materializeOrcadArtifact } from '../../orcad/orcad-artifact-materializer'
import {
  closeOrcadManagedTunnel,
  ensureOrcadManagedTunnel,
  startOrcadManagedTunnel
} from './orcad-managed-tunnel'
import { recoverInterruptedOrcadActivation } from '../activation/orcad-activation-recovery'
import { wakeAlreadyActiveOrcad } from '../../ssh/orcad-already-active-wake'
import { readOrcadActivationRecord } from '../activation/orcad-activation-record-store'
import { resolveOrcadRemoteContext, type OrcadRemoteContext } from '../install/orcad-remote-context'
import { deployOrcad } from '../../ssh/orcad-remote-deploy'
import {
  adoptRunningOrcadVersion,
  type OrcadRunningAdoption
} from '../../ssh/orcad-running-version-adoption'
import { readLocalFullVersion } from '../install/remote-versioned-install'
import { sshOrcadHostTransport } from '../../ssh/orcad-ssh-host-transport'
import { ORCAD_ACTIVATION_POLICY_REFUSED_CODE } from '../../ssh/orcad-installed-activation'
import { pruneManagedOrcadVersions } from './orcad-managed-version-gc'
import { tunneledOrcadPairingCode } from '../../ssh/orcad-tunneled-pairing'
import { resolveOrcadMigrationFence } from '../../ssh/orcad-migration-source-fence'
import type { SshTarget } from '../../../shared/ssh-types'
import { findCollidingEnvironmentName } from '../../../shared/runtime-environment-name-collision'
import { deployedOrcadTunnelChecks } from './orcad-managed-tunnel-identity'
import {
  isForceableOrcadDeferral,
  managedOrcadDeployPolicy,
  managedOrcadSlot,
  probeManagedOrcadReadiness,
  requireManagedOrcadInfrastructure
} from './orcad-managed-runtime-context'

export async function createManagedOrcadEnvironment(
  userDataPath: string,
  args: {
    name: string
    sshTargetId: string
    force?: boolean
    signal?: AbortSignal
    /** Deploying into a target fenced by a migration journal rather than claiming an empty one. */
    migration?: boolean
  }
): Promise<OrcadManagedDeployResult> {
  return runTargetLifecycle(args.sshTargetId, async () => {
    const { connectionManager, targetStore, claims } = requireManagedOrcadInfrastructure()
    const environmentId =
      getManagedOrcadFenceEnvironmentId(targetStore.getTarget(args.sshTargetId)) ?? randomUUID()
    const environments = listEnvironments(userDataPath)
    const registered = environments.find((entry) => entry.id === environmentId)
    if (registered) {
      assertRuntimeEnvironmentNotReconciling(registered)
      if (getOrcadSshDeployment(registered)?.sshTargetId !== args.sshTargetId) {
        throw new Error('The SSH target is owned by a server that is not deployed on it.')
      }
    }
    const namesake = findCollidingEnvironmentName(
      environments.filter((entry) => entry.id !== environmentId),
      args.name
    )
    if (namesake) {
      throw new Error(`A server named "${namesake.name}" already exists.`)
    }
    const current = targetStore.getTarget(args.sshTargetId)
    if (args.migration) {
      assertMigrationFence(userDataPath, current, environmentId, args.name)
    }
    const claimed = claims.claim(args.sshTargetId, environmentId, {
      // A migration records itself in its journal, not as a provisioning intent.
      ...(args.migration ? {} : { deployName: args.name }),
      // Why: this deploy's own claim left a provisioning intent or a journal, or registered a server.
      ownerRecorded:
        Boolean(args.migration) || Boolean(current?.orcadProvisioning) || Boolean(registered)
    })
    await claims.flush(args.signal)
    const targetGeneration = claimed.generation
    if (targetGeneration === undefined) {
      throw new Error('The SSH registration for this host’s Orca server has no durable generation.')
    }
    if (registered && getOrcadSshDeployment(registered)?.sshTargetGeneration !== targetGeneration) {
      throw new Error('The saved Orca server for this host has a stale SSH target generation.')
    }
    let environmentRegistered = false
    try {
      const connection = await connectionManager.connect(claimed)
      let context = await resolveOrcadRemoteContext(
        claimed,
        sshOrcadHostTransport(connection),
        args.signal
      )
      const slot = managedOrcadSlot(context, ORCAD_MANAGED_REMOTE_PORT, args.signal)
      const recovery = await recoverInterruptedOrcadActivation(slot)
      if (recovery.outcome === 'pending' || recovery.outcome === 'refused') {
        throw new Error(recovery.reason)
      }
      if (recovery.outcome === 'recovered') {
        context = { ...context, activationRecord: await readOrcadActivationRecord(slot) }
      }
      if (registered) {
        environmentRegistered = true
        const current = await ensureOrcadManagedTunnel(userDataPath, registered.id)
        const activeVersion = context.activationRecord.active
        if (!activeVersion) {
          throw new Error('This host’s Orca server has no active runtime version.')
        }
        return {
          outcome: 'already-current',
          environment: redactRuntimeEnvironment(current),
          activeVersion
        }
      }
      const localOrcadDir = await materializeOrcadArtifact(context.serverTarget, {
        signal: args.signal
      })
      // Before any upload, so a host another version serves is left exactly as it was. A migration
      // adopts too: only the paired server can count its terminals, so its own deploy would defer.
      const localVersion = readLocalFullVersion(localOrcadDir)
      const adopted = args.force
        ? null
        : await adoptRunningOrcadVersion(slot, context.activationRecord, localVersion)
      const { active } = context.activationRecord
      if (!adopted && !args.force && active && active !== localVersion) {
        // The wake re-read a record another desktop changed; the census policy follows it.
        context = { ...context, activationRecord: await readOrcadActivationRecord(slot) }
      }
      const serving: DeployedOrcad | OrcadManagedDeferral =
        adopted ??
        (await deployOwnOrcad(context, { ...slot, conn: connection }, localOrcadDir, args))
      if ('outcome' in serving) {
        return serving
      }
      // Why read back: orcad binds another port when the preferred one is taken on the host.
      const tunnel = deployedOrcadTunnelChecks(serving.readiness, serving.reprobe)
      const localPort = await startOrcadManagedTunnel(
        environmentId,
        claimed,
        connection,
        tunnel.remotePort,
        { ...tunnel, preferredPort: ORCAD_MANAGED_REMOTE_PORT }
      )
      const environment = addManagedOrcadEnvironment(userDataPath, {
        id: environmentId,
        name: args.name,
        pairingCode: tunneledOrcadPairingCode(tunnel.readiness(), localPort),
        orcadDeployment: {
          sshTargetId: claimed.id,
          sshTargetGeneration: targetGeneration,
          localPort,
          remotePort: ORCAD_MANAGED_REMOTE_PORT
        }
      })
      environmentRegistered = true
      return {
        // An adopted server keeps its version; the linked update check may replace it later.
        outcome: serving.created ? 'created' : 'already-current',
        environment: redactRuntimeEnvironment(environment),
        activeVersion: serving.version
      }
    } finally {
      if (!environmentRegistered) {
        await closeOrcadManagedTunnel(environmentId).catch(() => undefined)
      }
    }
  })
}

type DeployedOrcad = OrcadRunningAdoption & { created?: true }

async function deployOwnOrcad(
  context: OrcadRemoteContext<SshTarget>,
  slot: ReturnType<typeof managedOrcadSlot>,
  localOrcadDir: string,
  args: { force?: boolean; signal?: AbortSignal }
): Promise<DeployedOrcad | OrcadManagedDeferral> {
  const appVersion = getAppEnvironment().getVersion()
  const deployResult = await deployOrcad({
    ...slot,
    localOrcadDir,
    target: context.serverTarget,
    ...managedOrcadDeployPolicy(context, appVersion, args.force ? 'force' : 'connect'),
    force: args.force,
    appVersion
  })
  if (deployResult.outcome === 'installed-not-activated') {
    return {
      outcome: 'deferred',
      candidateVersion: deployResult.fullVersion,
      code: deployResult.code,
      reason: deployResult.reason,
      forceable:
        isForceableOrcadDeferral(deployResult.code) ||
        deployResult.code === ORCAD_ACTIVATION_POLICY_REFUSED_CODE
    }
  }
  if (deployResult.outcome === 'already-active') {
    await wakeAlreadyActiveOrcad(slot)
  }
  const reprobe = () =>
    probeManagedOrcadReadiness(context, localOrcadDir, deployResult.fullVersion, args.signal)
  const readiness = await reprobe()
  await pruneManagedOrcadVersions({
    slot,
    serverTarget: context.serverTarget,
    activeVersion: deployResult.fullVersion,
    readiness
  })
  return {
    version: deployResult.fullVersion,
    readiness,
    reprobe,
    ...(deployResult.outcome === 'already-active' ? {} : { created: true as const })
  }
}

function assertMigrationFence(
  userDataPath: string,
  target: SshTarget | undefined,
  environmentId: string,
  name: string
): void {
  const fence = target ? resolveOrcadMigrationFence(userDataPath, target) : null
  if (
    fence?.state !== 'fenced' ||
    fence.cutover.destinationEnvironmentId !== environmentId ||
    fence.cutover.destinationName !== name
  ) {
    throw new Error('orcad_migration_fence_required')
  }
}
