/** The move driver's connected WSL host: the distro's server, reached through its paired runtime. */
import { encodePairingOffer } from '../../../shared/remote-runtime/pairing/pairing'
import { getPreferredPairingOffer } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import { resolveEnvironment } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import { findWslHostDeployment } from '../../../shared/remote-runtime/host-store/runtime-environment-wsl-host-store'
import { orcadMigrationDestinationFor } from '../../managed-server/lifecycle/orcad-runtime-conversion-wiring'
import { ensureWslMoveDestinationBrowserLogins } from '../../persistence/moving-wsl-projects/desktop-state/wsl-move-browser-cookie-copy'
import { activeBrowserRoutePartitionOrcaProfileId } from '../../browser/routing/partitions/browser-route-partition-binding-runtime'
import { wslHostBrowserRouteStorage } from '../../browser/routing/local-host-partitions/wsl-host-browser-route-partition'
import type { WslMoveHost } from '../../persistence/moving-wsl-projects/execution/wsl-move-driver-ports'
import { commitRemoteOrcadMigrationCatalog } from '../../managed-server/migration/catalog/orcad-migration-catalog-client'
import { listRemoteOrcadRepositories } from '../../managed-server/migration/linking/orcad-server-repositories'
import { stageRemoteOrcadMigrationBlobChunk } from '../../managed-server/migration/transfers/orcad-migration-chunk-client'
import { listRemoteOrcadFolderCatalog } from '../../managed-server/migration/linking/orcad-server-folder-workspaces'
import { getWslHostService } from '../../wsl/host-lifecycle/wsl-host-service-instance'
import { defaultWslOrcadEnvironmentId } from '../../wsl/orcad/wsl-orcad-deploy'
import { getRuntimeEnvironmentStatus } from '../runtime-environments/status/runtime-environment-status-probe'
import {
  connectWslMoveHostService,
  wslMoveHostUpdatePending,
  type WslMoveHostConnectMode
} from './wsl-move-host-connect'

export async function connectWslMoveHost(
  userDataPath: string,
  distro: string,
  mode: WslMoveHostConnectMode
): Promise<WslMoveHost | null> {
  const service = getWslHostService()
  const environmentId = defaultWslOrcadEnvironmentId(distro)
  if (!service || !(await connectWslMoveHostService(service, userDataPath, distro, mode))) {
    return null
  }
  const { environment, notCarried } = await ensureWslMoveDestinationBrowserLogins({
    resolveEnvironment: async () => await resolveEnvironment(userDataPath, environmentId),
    resaveConnection: () => service.resaveConnection(environmentId),
    orcaProfileId: activeBrowserRoutePartitionOrcaProfileId,
    resolveHostStorage: wslHostBrowserRouteStorage
  })
  const status = await getRuntimeEnvironmentStatus(userDataPath, environmentId)
  if (!status.ok) {
    return null
  }
  const pairingCode = encodePairingOffer(getPreferredPairingOffer(environment))
  const options = environment.runtimeId ? { expectedRuntimeId: environment.runtimeId } : {}
  const distroGuid =
    (await findWslHostDeployment(userDataPath, environmentId))?.distroId ?? undefined
  return {
    environmentId,
    name: environment.name,
    ...(distroGuid ? { distroGuid } : {}),
    capabilities: status.result.capabilities ?? [],
    ...wslMoveHostUpdatePending(service, environmentId),
    ...(notCarried ? { browserLoginsNotCarried: notCarried } : {}),
    catalog: orcadMigrationDestinationFor(environment),
    commitWithBlobs: (manifest, expectedBlobs) =>
      commitRemoteOrcadMigrationCatalog(pairingCode, manifest, { ...options, expectedBlobs }),
    blobs: {
      stageChunk: (request) => stageRemoteOrcadMigrationBlobChunk(pairingCode, request, options)
    },
    readHolding: async () => {
      const [repositories, folders] = await Promise.all([
        listRemoteOrcadRepositories(pairingCode, options),
        listRemoteOrcadFolderCatalog(pairingCode, options)
      ])
      return {
        repoIds: repositories.map((repo) => repo.id),
        folderWorkspaceIds: folders.folderWorkspaces.map((folder) => folder.id),
        // The host keeps no per-distro generation it can report yet.
        highestGeneration: 0
      }
    }
  }
}
