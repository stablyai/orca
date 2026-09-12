import type { OrcadDelegatedConnectionSupervisor } from './orcad-delegated-connection-supervisor'
import type { PtyOwnershipTransferDestinationRuntimeRegistry } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-runtime'
import type { PtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import { parsePtyOwnershipTransferDestinationClaim } from '../../shared/pty-ownership-transfer-destination-claim'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import {
  samePtyOwnershipTransferCommitReceipt,
  samePtyOwnershipTransferPublicationReceipt
} from '../../shared/pty-ownership-transfer-receipt-validation'

export async function inspectOrcadPublishedDestinationActivation(options: {
  identity: PtyOwnershipTransferWireIdentity
  signal: AbortSignal
  registry: PtyOwnershipTransferDestinationRuntimeRegistry
  supervisor: OrcadDelegatedConnectionSupervisor
  connection: NonNullable<ReturnType<OrcadDelegatedConnectionSupervisor['getConnection']>>
}) {
  const { identity, signal, registry, supervisor, connection } = options
  signal.throwIfAborted()
  const catalogAdmission = registry
    .getPublishedDelegatedDestination(identity)
    .store.surface.loadCatalogAdmission(identity)
  const publication = registry
    .getPublishedDelegatedDestination(identity)
    .adapter.snapshot().publicationReceipt
  const claim = parsePtyOwnershipTransferDestinationClaim(connection.proof.destinationClaim)
  const status = await connection.client.status(connection.proof, { signal })
  signal.throwIfAborted()
  const current = registry
    .getPublishedDelegatedDestination(identity)
    .adapter.snapshot().publicationReceipt
  if (
    supervisor.getConnection(identity) !== connection ||
    !connection.isCommitReconciled() ||
    !catalogAdmission ||
    serializeOrcadMigrationValue(catalogAdmission) !==
      serializeOrcadMigrationValue(
        registry
          .getPublishedDelegatedDestination(identity)
          .store.surface.loadCatalogAdmission(identity)
      ) ||
    !publication ||
    !current ||
    !samePtyOwnershipTransferPublicationReceipt(publication, current) ||
    status.phase !== 'committed' ||
    !status.boundToConnection ||
    status.destinationClaim?.generation !== claim.generation ||
    status.destinationClaim.claimId !== claim.claimId ||
    !status.receipt ||
    !samePtyOwnershipTransferCommitReceipt(status.receipt, publication.commitReceipt)
  ) {
    throw new Error('orcad_delegated_pty_activation_unverifiable')
  }
  // Current connection evidence is not a durable release record or an execution-exit verdict.
  return structuredClone({
    identity,
    destinationClaim: claim,
    publicationReceipt: publication,
    catalogAdmission
  })
}
