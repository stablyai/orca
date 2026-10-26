import { getAppEnvironment } from '../../../shared/app-environment'
import {
  getManagedOrcadFenceEnvironmentId,
  managedOrcadServerName
} from '../../../shared/managed-orcad-ssh-owner'
import { listEnvironments } from '../../../shared/runtime-environment-store'
import { findOrcadMigrationSourceCutoverForTarget } from '../../ssh/orcad-migration-cutover-journal'
import { abandonOrcadConversion } from '../../ssh/orcad-conversion-abandon'
import { retainOrcadMigrationSource } from '../../ssh/orcad-migration-source-retention'
import { hasOrcadTemplate } from '../../orcad/orcad-artifact-materializer'
import { isOrcadHostUnavailableFixableOnHost } from '../../orcad/orcad-host-unavailable'
import { managedServerUpdateDeps } from '../../ssh/managed-server-update-deps'
import { ensureOrcadManagedTunnel } from '../../managed-server/lifecycle/orcad-managed-tunnel'
import { verifyOrcadManagedServing } from '../../managed-server/lifecycle/orcad-managed-serving-verify'
import { convertSshTargetToManagedOrcad } from '../../managed-server/lifecycle/orcad-runtime-conversion'
import {
  orcadMigrationDestinationFor,
  orcadServerFolderCatalogFor,
  orcadServerRepositoriesFor
} from '../../managed-server/lifecycle/orcad-runtime-conversion-wiring'
import { createManagedOrcadEnvironment } from '../../managed-server/lifecycle/orcad-runtime-deployment'
import type { HostServerOnConnectDeps } from '../../ssh/ssh-host-server-on-connect'
import {
  censusSshHostRelaysBeforeSession,
  relayTerminalsOnConnect
} from '../../ssh/legacy-relay/ssh-host-relay-terminals-on-connect'
import { requireManagedOrcadInfrastructure } from '../../managed-server/lifecycle/orcad-managed-runtime-context'
import { censusHostRelayTerminalsFor } from '../../ssh/legacy-relay/ssh-host-relay-census-for-target'
import { setSshHostServerStatus } from '../../ssh/ssh-host-server-status'
import { trackSshHostServerEvent } from '../../ssh/ssh-host-server-telemetry'
import { knownSshHostPlatform } from '../../ssh/ssh-host-platform-memo'
import { knownOrcadTunnelTransport } from '../../ssh/orcad-tunnel-transport-memo'
import { getSshTargetRegistryStore } from '../../ssh/targets/ssh-target-registry'
import { releaseUnreachableOrcadSetup } from '../../ssh/orcad-unreachable-setup-release'
import { getCurrentMainWindow } from './ssh-ipc-context'
import { broadcastSshState } from './ssh-renderer-broadcast'
import { connectInFlight } from './ssh-connect-attempt-registry'
import { startLegacyRelayBridge } from '../../ssh/legacy-relay/legacy-relay-bridge-registry'
import { isBridgeableLease } from '../../ssh/legacy-relay/legacy-relay-bridge-leases'

export function hostServerOnConnectDeps(userDataPath: string): HostServerOnConnectDeps {
  const registry = getSshTargetRegistryStore()!
  const claims = registry.getOrcadRuntimeClaims()
  const store = registry.getOrcadMigrationSource()
  const appVersion = getAppEnvironment().getVersion()
  const isRegistered = (environmentId: string): boolean =>
    listEnvironments(userDataPath).some((entry) => entry.id === environmentId)
  return {
    // A fence alone may be unfinished setup; only registered servers count.
    managedEnvironmentId: (target) => {
      const environmentId = getManagedOrcadFenceEnvironmentId(target)
      return environmentId && isRegistered(environmentId) ? environmentId : null
    },
    ensureTunnel: async (environmentId) => {
      await ensureOrcadManagedTunnel(userDataPath, environmentId)
    },
    ensureServing: (environmentId) => verifyOrcadManagedServing(userDataPath, environmentId),
    retainCommittedSource: async (target) => {
      const head = findOrcadMigrationSourceCutoverForTarget(userDataPath, target.id)
      if (head?.phase === 'destination-committed') {
        await retainOrcadMigrationSource(userDataPath, head.migrationId, store)
      }
    },
    hasTemplate: hasOrcadTemplate,
    recordedUnavailable: (target) =>
      target.managedServerUnavailable?.appVersion === appVersion
        ? target.managedServerUnavailable.reason
        : null,
    recordUnavailable: (target, reason) => {
      if (!isOrcadHostUnavailableFixableOnHost(reason)) {
        registry.updateTarget(target.id, { managedServerUnavailable: { reason, appVersion } })
      }
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
        censusHost: async () =>
          censusSshHostRelaysBeforeSession(
            await requireManagedOrcadInfrastructure().connectionManager.connect(target),
            target.id
          )
      }),
    deploy: (target) =>
      createManagedOrcadEnvironment(userDataPath, {
        name: target.orcadProvisioning?.name ?? managedOrcadServerName(target),
        sshTargetId: target.id
      }),
    convert: async (target, hostProof) => {
      // COMPAT(legacy-relay-bridge): find the panes old relays still run before the tabs remount.
      if (hostProof?.bridged) {
        await startLegacyRelayBridge(target.id)
      }
      const converted = await convertSshTargetToManagedOrcad(userDataPath, {
        sshTargetId: target.id,
        name: managedOrcadServerName(target),
        // The connect's own census already answered; a conversion before any session reuses it.
        censusHost: (host) =>
          hostProof ? Promise.resolve(hostProof) : censusHostRelayTerminalsFor(host)(),
        isBridgedPaneLease: isBridgeableLease,
        // Releasing the direct session here would cancel the connect that requested conversion.
        destinationFor: orcadMigrationDestinationFor,
        serverRepositoriesFor: orcadServerRepositoriesFor,
        serverFolderCatalogFor: orcadServerFolderCatalogFor
      })
      if (converted.outcome === 'converted' || converted.outcome === 'refused') {
        // Move-anyway consent covers one attempt; retain it on failure so held-fence verification can resume.
        registry.updateTarget(target.id, { managedServerLeaveBehind: undefined })
      }
      return converted
    },
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
      // Cancelled decisions keep running; their progress must not revive connection status.
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
