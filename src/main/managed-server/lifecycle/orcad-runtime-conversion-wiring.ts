/** The live collaborators a host conversion needs: the census, the direct session and the server. */
import { encodePairingOffer } from '../../../shared/pairing'
import {
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import { disconnectRegisteredSshTarget } from '../../ipc/ssh/ssh-session-teardown'
import type { OrcadMigrationDestinationCatalog } from '../../ssh/orcad-migration-cutover-coordinator'
import {
  abortRemoteOrcadMigrationCatalog,
  commitRemoteOrcadMigrationCatalog,
  listRemoteOrcadRepositories,
  readRemoteOrcadMigrationCatalogState,
  stageRemoteOrcadMigrationCatalog,
  stageRemoteOrcadMigrationSnapshotChunk
} from '../../ssh/orcad-migration-catalog-client'
import { censusHostRelayTerminalsFor } from '../../ssh/legacy-relay/ssh-host-relay-census-for-target'
import type { OrcadManagedConversionArgs } from './orcad-runtime-conversion'
import type { OrcadServerRepository } from '../../ssh/orcad-migration-repository-link'
import {
  listRemoteOrcadFolderCatalog,
  type OrcadServerFolderCatalog
} from '../../ssh/orcad-server-folder-workspaces'

/** The T6-9 client against this server, pinned to the runtime it paired with. */
export function orcadMigrationDestinationFor(
  environment: KnownRuntimeEnvironment
): OrcadMigrationDestinationCatalog {
  const pairingCode = encodePairingOffer(getPreferredPairingOffer(environment))
  const options = environment.runtimeId ? { expectedRuntimeId: environment.runtimeId } : {}
  return {
    readState: (manifest) => readRemoteOrcadMigrationCatalogState(pairingCode, manifest, options),
    stage: (manifest) => stageRemoteOrcadMigrationCatalog(pairingCode, manifest, options),
    commit: (manifest) => commitRemoteOrcadMigrationCatalog(pairingCode, manifest, options),
    abort: (manifest) => abortRemoteOrcadMigrationCatalog(pairingCode, manifest, options),
    stageChunk: (request) => stageRemoteOrcadMigrationSnapshotChunk(pairingCode, request, options)
  }
}

/** The projects this server already holds, read through the same pinned pairing. */
export function orcadServerRepositoriesFor(
  environment: KnownRuntimeEnvironment
): Promise<OrcadServerRepository[]> {
  const pairingCode = encodePairingOffer(getPreferredPairingOffer(environment))
  return listRemoteOrcadRepositories(
    pairingCode,
    environment.runtimeId ? { expectedRuntimeId: environment.runtimeId } : {}
  )
}

/** The folder workspaces this server already holds, read through the same pinned pairing. */
export function orcadServerFolderCatalogFor(
  environment: KnownRuntimeEnvironment
): Promise<OrcadServerFolderCatalog> {
  const pairingCode = encodePairingOffer(getPreferredPairingOffer(environment))
  return listRemoteOrcadFolderCatalog(
    pairingCode,
    environment.runtimeId ? { expectedRuntimeId: environment.runtimeId } : {}
  )
}

export function conversionCollaborators(): Pick<
  OrcadManagedConversionArgs,
  | 'destinationFor'
  | 'serverRepositoriesFor'
  | 'serverFolderCatalogFor'
  | 'censusHost'
  | 'releaseDirectSession'
> {
  return {
    destinationFor: orcadMigrationDestinationFor,
    serverRepositoriesFor: orcadServerRepositoriesFor,
    serverFolderCatalogFor: orcadServerFolderCatalogFor,
    censusHost: (target) => censusHostRelayTerminalsFor(target)(),
    releaseDirectSession: disconnectRegisteredSshTarget
  }
}
