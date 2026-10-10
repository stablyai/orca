/** The live collaborators a host conversion needs: the relay, the direct session and the server. */
import { encodePairingOffer } from '../../shared/pairing'
import {
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { disconnectRegisteredSshTarget } from '../ipc/ssh-session-teardown'
import type { OrcadMigrationDestinationCatalog } from './orcad-migration-cutover-coordinator'
import {
  abortRemoteOrcadMigrationCatalog,
  commitRemoteOrcadMigrationCatalog,
  readRemoteOrcadMigrationCatalogState,
  stageRemoteOrcadMigrationCatalog,
  stageRemoteOrcadMigrationSnapshotChunk
} from './orcad-migration-catalog-client'
import { orcadMigrationRelayPtyLister } from './orcad-migration-relay-pty-lister'
import { censusHostRelayTerminalsFor } from './ssh-host-relay-census-for-target'
import type { OrcadManagedConversionArgs } from './orcad-runtime-conversion'

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

export function conversionCollaborators(
  sshTargetId: string
): Pick<
  OrcadManagedConversionArgs,
  'destinationFor' | 'listRelayPtyIds' | 'censusHost' | 'releaseDirectSession'
> {
  return {
    destinationFor: orcadMigrationDestinationFor,
    listRelayPtyIds: orcadMigrationRelayPtyLister(sshTargetId),
    censusHost: (target) => censusHostRelayTerminalsFor(target)(),
    releaseDirectSession: disconnectRegisteredSshTarget
  }
}
