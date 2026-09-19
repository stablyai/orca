import { randomUUID } from 'node:crypto'
import { assertRuntimeEnvironmentNotReconciling } from '../../shared/runtime-environment-reconciliation-record'
import {
  addEnvironmentFromPairingCode,
  listEnvironments,
  restoreManagedOrcadEnvironmentLink
} from '../../shared/runtime-environment-store'
import {
  getPreferredPairingOffer,
  redactRuntimeEnvironment,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { encodePairingOffer } from '../../shared/pairing'
import {
  ORCAD_MANAGED_REMOTE_PORT,
  type OrcadManagedDeployResult
} from '../../shared/orcad-managed-runtime'
import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
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
import { createOrcadMigrationManifest } from './orcad-migration-manifest-export'
import {
  beginOrcadMigrationSourceCutoverDurably,
  commitOrcadMigrationDestination,
  retireOrcadMigrationSourceCatalogDurably,
  type SourceCutoverStore
} from './orcad-migration-cutover-coordinator'
import { hasRegisteredDirectSshAuthority } from './ssh-target-registry'
import { environmentMatchesManagedOrcadCutover } from './orcad-managed-migration-status'
import {
  isForceableOrcadDeferral,
  ORCAD_BIND_HOST,
  requireManagedOrcadInfrastructure,
  resolveActiveOrcadNodeFallback,
  resolveOrcadDeployReadiness
} from './orcad-managed-runtime-context'

export async function createManagedOrcadEnvironment(
  userDataPath: string,
  args: { name: string; sshTargetId: string; force?: boolean; signal?: AbortSignal }
): Promise<OrcadManagedDeployResult> {
  return runTargetLifecycle(args.sshTargetId, async () => {
    const { connectionManager, targetStore } = requireManagedOrcadInfrastructure()
    const migrationStore = targetStore.getOrcadMigrationStore()
    const existingCutover = migrationStore
      .listOrcadMigrationSourceCutovers()
      .find((entry) => entry.manifest.source.sshTargetId === args.sshTargetId)
    const environmentId = existingCutover?.destinationEnvironmentId ?? randomUUID()
    const registeredEnvironments = listEnvironments(userDataPath)
    let registeredEnvironment = registeredEnvironments.find((entry) => entry.id === environmentId)
    if (registeredEnvironment) {
      assertRuntimeEnvironmentNotReconciling(registeredEnvironment)
    }
    if (registeredEnvironment && !existingCutover) {
      throw new Error('The generated managed Orca environment id is already in use.')
    }
    if (registeredEnvironment && existingCutover) {
      assertEnvironmentCanResumeCutover(registeredEnvironment, existingCutover)
    }
    if (
      registeredEnvironments.some((entry) => entry.id !== environmentId && entry.name === args.name)
    ) {
      throw new Error(`A server named "${args.name}" already exists.`)
    }
    const target = targetStore.assertOrcadRuntimeTargetClaimable(args.sshTargetId, environmentId)
    if (hasRegisteredDirectSshAuthority(target.id)) {
      throw new Error('Disconnect this SSH host before converting it to a managed Orca server.')
    }
    const manifest =
      existingCutover?.manifest ??
      createOrcadMigrationManifest(migrationStore, target, {
        destinationEnvironmentId: environmentId
      })
    const cutover = await beginOrcadMigrationSourceCutoverDurably({
      store: migrationStore,
      manifest,
      destinationEnvironmentId: environmentId,
      destinationName: args.name,
      signal: args.signal
    })
    const fenced = targetStore.getTarget(target.id)
    if (!fenced || getManagedOrcadOwnerEnvironmentId(fenced.owner) !== environmentId) {
      throw new Error('The managed Orca migration source fence was lost before deployment.')
    }
    if (
      registeredEnvironment?.orcadDeployment &&
      fenced.generation !== registeredEnvironment.orcadDeployment.sshTargetGeneration
    ) {
      throw new Error('The saved managed Orca environment has a stale SSH target generation.')
    }
    const claimed = targetStore.ensureOrcadRuntimeTargetGeneration(target.id, environmentId)
    const targetGeneration = claimed.generation
    if (targetGeneration === undefined) {
      throw new Error('The managed Orca SSH registration has no durable generation.')
    }
    await migrationStore.flushPendingOrThrowAsync({
      signal: args.signal,
      drainToStableGeneration: false
    })
    let environmentRegistered = false
    try {
      const connection = await connectionManager.connect(claimed)
      let context = await resolveOrcadRemoteContext(claimed, connection, args.signal)
      const recovery = await recoverInterruptedOrcadActivation({
        conn: context.connection,
        host: context.host,
        remoteHome: context.remoteHome,
        userDataDir: context.userDataDir,
        bindHost: ORCAD_BIND_HOST,
        port: ORCAD_MANAGED_REMOTE_PORT,
        signal: args.signal
      })
      if (recovery.outcome === 'pending' || recovery.outcome === 'refused') {
        throw new Error(recovery.reason)
      }
      if (recovery.outcome === 'recovered') {
        context = {
          ...context,
          activationRecord: await readOrcadActivationRecord({
            conn: context.connection,
            host: context.host,
            remoteHome: context.remoteHome,
            signal: args.signal
          })
        }
      }
      if (registeredEnvironment && existingCutover) {
        registeredEnvironment = restoreManagedOrcadEnvironmentLink(userDataPath, environmentId, {
          sshTargetId: claimed.id,
          sshTargetGeneration: targetGeneration,
          remotePort: ORCAD_MANAGED_REMOTE_PORT
        })
        assertEnvironmentMatchesCutover(registeredEnvironment, existingCutover, targetGeneration)
      }
      if (registeredEnvironment) {
        environmentRegistered = true
        await ensureOrcadManagedTunnel(userDataPath, registeredEnvironment.id)
        await commitAndRetireStaticCatalog({
          store: migrationStore,
          cutover,
          pairingCode: encodePairingOffer(getPreferredPairingOffer(registeredEnvironment)),
          signal: args.signal
        })
        const activeVersion = context.activationRecord.active
        if (!activeVersion) {
          throw new Error('The recovered managed Orca environment has no active runtime version.')
        }
        return {
          outcome: 'already-current',
          environment: redactRuntimeEnvironment(registeredEnvironment),
          activeVersion
        }
      }
      const localOrcadDir = await materializeOrcadArtifact(context.bunTarget, {
        signal: args.signal
      })
      const nodePath = await resolveActiveOrcadNodeFallback(context, args.signal)
      const deployResult = await deployOrcad({
        conn: connection,
        host: context.host,
        remoteHome: context.remoteHome,
        localOrcadDir,
        buildTarget: context.bunTarget,
        nodePath,
        userDataDir: context.userDataDir,
        bindHost: ORCAD_BIND_HOST,
        port: ORCAD_MANAGED_REMOTE_PORT,
        census: context.activationRecord.active
          ? { liveSessions: null, startedSinceActivation: null }
          : { liveSessions: 0, startedSinceActivation: 0 },
        force: args.force,
        signal: args.signal
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
      const readiness = await resolveOrcadDeployReadiness(
        context,
        localOrcadDir,
        deployResult,
        nodePath,
        ORCAD_MANAGED_REMOTE_PORT,
        args.signal
      )
      const localPort = await startOrcadManagedTunnel(
        environmentId,
        claimed,
        connection,
        ORCAD_MANAGED_REMOTE_PORT
      )
      const pairingCode = tunneledOrcadPairingCode(readiness, localPort)
      const environment = addEnvironmentFromPairingCode(userDataPath, {
        id: environmentId,
        name: args.name,
        pairingCode,
        connectionDependency: 'ssh-tunnel',
        orcadDeployment: {
          sshTargetId: claimed.id,
          sshTargetGeneration: targetGeneration,
          localPort,
          remotePort: ORCAD_MANAGED_REMOTE_PORT
        }
      })
      environmentRegistered = true
      await commitAndRetireStaticCatalog({
        store: migrationStore,
        cutover,
        pairingCode,
        signal: args.signal
      })
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

async function commitAndRetireStaticCatalog(args: {
  store: SourceCutoverStore
  cutover: OrcadMigrationSourceCutover
  pairingCode: string
  signal?: AbortSignal
}): Promise<void> {
  await commitOrcadMigrationDestination({
    store: args.store,
    migrationId: args.cutover.manifest.migrationId,
    pairingCode: args.pairingCode,
    options: { signal: args.signal }
  })
  await retireOrcadMigrationSourceCatalogDurably({
    store: args.store,
    migrationId: args.cutover.manifest.migrationId,
    signal: args.signal
  })
}

function assertEnvironmentMatchesCutover(
  environment: KnownRuntimeEnvironment,
  cutover: OrcadMigrationSourceCutover,
  expectedTargetGeneration: number
): void {
  if (!environmentMatchesManagedOrcadCutover(environment, cutover, expectedTargetGeneration)) {
    throw new Error('The saved managed Orca environment does not match its migration journal.')
  }
}

function assertEnvironmentCanResumeCutover(
  environment: KnownRuntimeEnvironment,
  cutover: OrcadMigrationSourceCutover
): void {
  if (
    environment.id !== cutover.destinationEnvironmentId ||
    (cutover.destinationName !== undefined && environment.name !== cutover.destinationName) ||
    (environment.orcadDeployment && !environmentMatchesManagedOrcadCutover(environment, cutover))
  ) {
    throw new Error('The saved managed Orca environment does not match its migration journal.')
  }
}
