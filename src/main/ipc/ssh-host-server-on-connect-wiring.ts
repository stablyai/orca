/** The live collaborators behind each connect's server decision. */
import { getAppEnvironment } from '../../shared/app-environment'
import { getManagedOrcadFenceEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import { isRetainedOrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import { listEnvironments } from '../../shared/runtime-environment-store'
import type { SshTarget } from '../../shared/ssh-types'
import type { Store } from '../persistence'
import { findOrcadMigrationSourceCutoverForTarget } from '../ssh/orcad-migration-cutover-journal'
import { orcadMigrationRelayPtyLister } from '../ssh/orcad-migration-relay-pty-lister'
import { releaseUndeployedMigrationFence } from '../ssh/orcad-migration-source-fence'
import { isOrcadSourceRetirementEnabled } from '../ssh/orcad-migration-source-retention'
import { retireOrcadMigrationSource } from '../ssh/orcad-migration-source-retirement'
import { assessOrcadMigrationTerminals } from '../ssh/orcad-migration-terminal-gate'
import { hasOrcadTemplate } from '../ssh/orcad-artifact-materializer'
import { ensureOrcadManagedTunnel } from '../ssh/orcad-managed-tunnel'
import { compareRetainedOrcadSource } from '../ssh/orcad-retained-source'
import { convertSshTargetToManagedOrcad } from '../ssh/orcad-runtime-conversion'
import { orcadMigrationDestinationFor } from '../ssh/orcad-runtime-conversion-wiring'
import { createManagedOrcadEnvironment } from '../ssh/orcad-runtime-deployment'
import type { HostServerOnConnectDeps } from '../ssh/ssh-host-server-on-connect'
import { setSshHostServerStatus } from '../ssh/ssh-host-server-status'
import {
  getSshTargetRegistryStore,
  hasRegisteredDirectSshAuthority
} from '../ssh/ssh-target-registry'
import { getCurrentMainWindow } from './ssh-ipc-context'
import { broadcastSshState } from './ssh-renderer-broadcast'
import { disconnectRegisteredSshTarget } from './ssh-session-teardown'
import { runTargetLifecycle } from './ssh-target-lifecycle-queue'

export function hostServerOnConnectDeps(userDataPath: string): HostServerOnConnectDeps {
  const registry = getSshTargetRegistryStore()!
  const claims = registry.getOrcadRuntimeClaims()
  const store = registry.getOrcadMigrationSource()
  const appVersion = getAppEnvironment().getVersion()
  const isRegistered = (environmentId: string): boolean =>
    listEnvironments(userDataPath).some((entry) => entry.id === environmentId)
  return {
    // Why registered only: a fence whose server never registered is an unfinished setup, not a server.
    managedEnvironmentId: (target) => {
      const environmentId = getManagedOrcadFenceEnvironmentId(target)
      return environmentId && isRegistered(environmentId) ? environmentId : null
    },
    ensureTunnel: async (environmentId) => {
      await ensureOrcadManagedTunnel(userDataPath, environmentId)
    },
    retireRetainedSource: (target) => retireRetainedSource(userDataPath, store, target),
    hasTemplate: hasOrcadTemplate,
    recordedUnavailable: (target) =>
      target.managedServerUnavailable?.appVersion === appVersion
        ? target.managedServerUnavailable.reason
        : null,
    recordUnavailable: (target, reason) => {
      registry.updateTarget(target.id, { managedServerUnavailable: { reason, appVersion } })
    },
    isEmptyHost: (target) => {
      // An interrupted empty-host deploy passes its own claim, recorded by its provisioning intent.
      const environmentId = getManagedOrcadFenceEnvironmentId(target)
      return claims.preflight(
        target.id,
        environmentId
          ? { environmentId, recorded: target.orcadProvisioning !== undefined }
          : undefined
      ).claimable
    },
    relayTerminals: async (target) => {
      const proof = await assessOrcadMigrationTerminals(
        store,
        target.id,
        orcadMigrationRelayPtyLister(target.id)
      )
      return proof.verdict === 'exited'
        ? { verdict: 'exited', count: 0 }
        : { verdict: proof.verdict, count: proof.ptyIds.length }
    },
    deploy: (target) =>
      createManagedOrcadEnvironment(userDataPath, {
        name: target.orcadProvisioning?.name ?? target.label,
        sshTargetId: target.id
      }),
    convert: (target) =>
      convertSshTargetToManagedOrcad(userDataPath, {
        sshTargetId: target.id,
        name: target.label,
        listRelayPtyIds: orcadMigrationRelayPtyLister(target.id),
        destinationFor: orcadMigrationDestinationFor,
        // Why guarded: this runs before the connect registers a session, and an unconditional
        // disconnect would cancel the very connect attempt that asked for the conversion.
        releaseDirectSession: async (targetId) => {
          if (hasRegisteredDirectSshAuthority(targetId)) {
            await disconnectRegisteredSshTarget(targetId)
          }
        }
      }),
    abandonDeploy: async (target) => {
      const environmentId =
        getManagedOrcadFenceEnvironmentId(target) ??
        getManagedOrcadFenceEnvironmentId(registry.getTarget(target.id))
      if (environmentId && !isRegistered(environmentId)) {
        claims.release(target.id, environmentId)
        await claims.flush()
      }
    },
    abandonConversion: async (target) => {
      await releaseUndeployedMigrationFence({
        userDataPath,
        claims,
        targetId: target.id,
        isDestinationRegistered: isRegistered
      })
    },
    progress: (target, phase) => {
      setSshHostServerStatus(target.id, { kind: 'setting-up', phase })
      broadcastSshState(getCurrentMainWindow, target.id, {
        targetId: target.id,
        status: 'connecting',
        error: null,
        reconnectAttempt: 0
      })
    }
  }
}

async function retireRetainedSource(
  userDataPath: string,
  store: Store,
  target: SshTarget
): Promise<void> {
  if (!isOrcadSourceRetirementEnabled()) {
    return
  }
  const cutover = findOrcadMigrationSourceCutoverForTarget(userDataPath, target.id)
  if (!cutover || !isRetainedOrcadMigrationSourceCutover(cutover)) {
    return
  }
  // Why compare first: rows an older build changed are a new move, never something to delete.
  if (compareRetainedOrcadSource(store, target, cutover.manifest.payload) !== 'unchanged') {
    return
  }
  const environment =
    listEnvironments(userDataPath).find((entry) => entry.id === cutover.destinationEnvironmentId) ??
    null
  await runTargetLifecycle(target.id, () =>
    retireOrcadMigrationSource({ userDataPath, store, environment }, cutover.migrationId)
  )
}
