/** The live collaborators behind each connect's server decision. */
import { getAppEnvironment } from '../../shared/app-environment'
import { getManagedOrcadFenceEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { findOrcadMigrationSourceCutoverForTarget } from '../ssh/orcad-migration-cutover-journal'
import { orcadMigrationRelayPtyLister } from '../ssh/orcad-migration-relay-pty-lister'
import { abandonOrcadConversion } from '../ssh/orcad-conversion-abandon'
import { retainOrcadMigrationSource } from '../ssh/orcad-migration-source-retention'
import { hasOrcadTemplate } from '../ssh/orcad-artifact-materializer'
import { managedServerUpdateDeps } from '../ssh/managed-server-update-deps'
import { ensureOrcadManagedTunnel } from '../ssh/orcad-managed-tunnel'
import { verifyOrcadManagedServing } from '../ssh/orcad-managed-serving-verify'
import { convertSshTargetToManagedOrcad } from '../ssh/orcad-runtime-conversion'
import { orcadMigrationDestinationFor } from '../ssh/orcad-runtime-conversion-wiring'
import { createManagedOrcadEnvironment } from '../ssh/orcad-runtime-deployment'
import type { HostServerOnConnectDeps } from '../ssh/ssh-host-server-on-connect'
import {
  censusSshHostRelaysBeforeSession,
  relayTerminalsOnConnect
} from '../ssh/ssh-host-relay-terminals-on-connect'
import { requireManagedOrcadInfrastructure } from '../ssh/orcad-managed-runtime-context'
import { censusHostRelayTerminalsFor } from '../ssh/ssh-host-relay-census-for-target'
import { setSshHostServerStatus } from '../ssh/ssh-host-server-status'
import { trackSshHostServerEvent } from '../ssh/ssh-host-server-telemetry'
import { knownSshHostPlatform } from '../ssh/ssh-host-platform-memo'
import { knownOrcadTunnelTransport } from '../ssh/orcad-tunnel-transport-memo'
import {
  getSshTargetRegistryStore,
  hasRegisteredDirectSshAuthority
} from '../ssh/ssh-target-registry'
import { releaseUnreachableOrcadSetup } from '../ssh/orcad-unreachable-setup-release'
import { getCurrentMainWindow } from './ssh-ipc-context'
import { broadcastSshState } from './ssh-renderer-broadcast'
import { disconnectRegisteredSshTarget } from './ssh-session-teardown'
import { connectInFlight } from './ssh-connect-attempt-registry'

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
    ensureServing: (environmentId) => verifyOrcadManagedServing(userDataPath, environmentId),
    retainCommittedSource: (target) => {
      const head = findOrcadMigrationSourceCutoverForTarget(userDataPath, target.id)
      if (head?.phase === 'destination-committed') {
        retainOrcadMigrationSource(userDataPath, head.migrationId)
      }
    },
    hasTemplate: hasOrcadTemplate,
    recordedUnavailable: (target) =>
      target.managedServerUnavailable?.appVersion === appVersion
        ? target.managedServerUnavailable.reason
        : null,
    recordUnavailable: (target, reason) => {
      registry.updateTarget(target.id, { managedServerUnavailable: { reason, appVersion } })
    },
    ...managedServerUpdateDeps(userDataPath),
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
    relayTerminals: (target) =>
      relayTerminalsOnConnect({
        store,
        targetId: target.id,
        listRelayPtyIds: orcadMigrationRelayPtyLister(target.id),
        censusHost: async () =>
          censusSshHostRelaysBeforeSession(
            await requireManagedOrcadInfrastructure().connectionManager.connect(target),
            target.id
          )
      }),
    deploy: (target) =>
      createManagedOrcadEnvironment(userDataPath, {
        name: target.orcadProvisioning?.name ?? target.label,
        sshTargetId: target.id
      }),
    convert: (target, hostProof) =>
      convertSshTargetToManagedOrcad(userDataPath, {
        sshTargetId: target.id,
        name: target.label,
        listRelayPtyIds: orcadMigrationRelayPtyLister(target.id),
        // The connect's own census already answered; a conversion before any session reuses it.
        censusHost: (host) =>
          hostProof ? Promise.resolve(hostProof) : censusHostRelayTerminalsFor(host)(),
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
    hasUnfinishedConversion: (target) => {
      const head = findOrcadMigrationSourceCutoverForTarget(userDataPath, target.id)
      return (
        head !== null &&
        !head.supersedesMigrationId &&
        (head.phase === 'source-fenced' || head.phase === 'destination-staged')
      )
    },
    abandonConversion: async (target) => {
      await abandonOrcadConversion({
        userDataPath,
        store,
        claims,
        targetId: target.id,
        destinationFor: orcadMigrationDestinationFor
      })
    },
    isFencedBeforeStaging: (target) =>
      findOrcadMigrationSourceCutoverForTarget(userDataPath, target.id)?.phase === 'source-fenced',
    releaseUnreachableSetup: (target) =>
      releaseUnreachableOrcadSetup({ userDataPath, claims, targetId: target.id }),
    // Read at report time: a deploy or conversion learns the platform while the decision runs.
    report: (target, event) =>
      trackSshHostServerEvent(
        event,
        knownSshHostPlatform(target.id),
        knownOrcadTunnelTransport(target.id)
      ),
    progress: (target, phase) => {
      // A cancelled connect's decision keeps running; its progress must not revive the status.
      if (!connectInFlight.has(target.id)) {
        return
      }
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
