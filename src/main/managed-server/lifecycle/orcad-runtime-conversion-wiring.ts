import { encodePairingOffer } from '../../../shared/remote-runtime/pairing/pairing'
import {
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import { disconnectRegisteredSshTarget } from '../../ipc/ssh/ssh-session-teardown'
import type { OrcadMigrationDestinationCatalog } from '../migration/cutover/orcad-migration-cutover-coordinator'
import {
  abortRemoteOrcadMigrationCatalog,
  commitRemoteOrcadMigrationCatalog,
  readRemoteOrcadMigrationCatalogState,
  stageRemoteOrcadMigrationCatalog
} from '../migration/catalog/orcad-migration-catalog-client'
import { listRemoteOrcadRepositories } from '../migration/linking/orcad-server-repositories'
import {
  stageRemoteOrcadMigrationBlobChunk,
  stageRemoteOrcadMigrationSnapshotChunk
} from '../migration/transfers/orcad-migration-chunk-client'
import { readRemoteOrcadMigrationCapabilities } from '../migration/catalog/orcad-migration-capabilities-client'
import { abortRemoteOrcadMigrationCatalogByReference } from '../migration/catalog/orcad-migration-catalog-reference-client'
import {
  enableRemoteOrcadAutomation,
  type EnableServerAutomation
} from '../../persistence/migrating-orcad-catalog/orcad-migration-moved-automations'
import { censusHostRelayTerminalsFor } from '../../ssh/legacy-relay/endpoints/ssh-host-relay-census-for-target'
import { isBridgeableLease } from '../../ssh/legacy-relay/bridge/legacy-relay-bridge-leases'
import type { OrcadManagedConversionArgs } from './orcad-runtime-conversion'
import type { OrcadServerRepository } from '../migration/linking/orcad-server-repositories'
import {
  listRemoteOrcadFolderCatalog,
  type OrcadServerFolderCatalog
} from '../migration/linking/orcad-server-folder-workspaces'

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
    abortByReference: (manifest) =>
      abortRemoteOrcadMigrationCatalogByReference(pairingCode, manifest, options),
    stageChunk: (request) => stageRemoteOrcadMigrationSnapshotChunk(pairingCode, request, options),
    readCapabilities: () => readRemoteOrcadMigrationCapabilities(pairingCode, options),
    stageBlobChunk: (request) => stageRemoteOrcadMigrationBlobChunk(pairingCode, request, options)
  }
}

export function orcadServerRepositoriesFor(
  environment: KnownRuntimeEnvironment
): Promise<OrcadServerRepository[]> {
  const pairingCode = encodePairingOffer(getPreferredPairingOffer(environment))
  return listRemoteOrcadRepositories(
    pairingCode,
    environment.runtimeId ? { expectedRuntimeId: environment.runtimeId } : {}
  )
}

export function orcadServerFolderCatalogFor(
  environment: KnownRuntimeEnvironment
): Promise<OrcadServerFolderCatalog> {
  const pairingCode = encodePairingOffer(getPreferredPairingOffer(environment))
  return listRemoteOrcadFolderCatalog(
    pairingCode,
    environment.runtimeId ? { expectedRuntimeId: environment.runtimeId } : {}
  )
}

export function orcadServerAutomationEnablerFor(
  environment: KnownRuntimeEnvironment
): EnableServerAutomation {
  const pairingCode = encodePairingOffer(getPreferredPairingOffer(environment))
  const options = environment.runtimeId ? { expectedRuntimeId: environment.runtimeId } : {}
  return (automation) => enableRemoteOrcadAutomation(pairingCode, automation, options)
}

export function conversionCollaborators(): Pick<
  OrcadManagedConversionArgs,
  | 'destinationFor'
  | 'serverRepositoriesFor'
  | 'serverFolderCatalogFor'
  | 'serverAutomationEnablerFor'
  | 'censusHost'
  | 'isBridgedPaneLease'
  | 'releaseDirectSession'
> {
  return {
    destinationFor: orcadMigrationDestinationFor,
    serverRepositoriesFor: orcadServerRepositoriesFor,
    serverFolderCatalogFor: orcadServerFolderCatalogFor,
    serverAutomationEnablerFor: orcadServerAutomationEnablerFor,
    censusHost: (target) => censusHostRelayTerminalsFor(target)(),
    isBridgedPaneLease: isBridgeableLease,
    releaseDirectSession: disconnectRegisteredSshTarget
  }
}
