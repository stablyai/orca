import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { parsePtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import { parsePtyOwnershipTransferDestinationClaim } from '../../shared/pty-ownership-transfer-destination-claim'
import { inspectOrcadPublishedDestinationActivation } from './orcad-delegated-activation'

/** Fresh publication/claim plus durable applied output; not source cleanup or completion. */
export async function inspectOrcadPublishedDestinationOutputCoverage(
  options: Parameters<typeof inspectOrcadPublishedDestinationActivation>[0] & {
    throughSeq: number
  }
) {
  const identity = Object.freeze(parsePtyOwnershipTransferWireIdentity(options.identity))
  const { throughSeq, connection, registry, supervisor, signal } = options
  if (!Number.isSafeInteger(throughSeq) || throughSeq < 0) {
    throw new Error('orcad_destination_output_coverage_sequence_invalid')
  }
  const activation = await inspectOrcadPublishedDestinationActivation({ ...options, identity })
  const expected = serializeOrcadMigrationValue({
    publication: activation.publicationReceipt,
    catalog: activation.catalogAdmission,
    claim: activation.destinationClaim
  })
  const assertCurrent = () => {
    signal.throwIfAborted()
    const destination = registry.getPublishedDelegatedDestination(identity)
    if (
      supervisor.getConnection(identity) !== connection ||
      !connection.isActive() ||
      !connection.isCommitReconciled() ||
      serializeOrcadMigrationValue({
        publication: destination.adapter.snapshot().publicationReceipt,
        catalog: destination.store.surface.loadCatalogAdmission(identity),
        claim: parsePtyOwnershipTransferDestinationClaim(connection.proof.destinationClaim)
      }) !== expected
    ) {
      throw new Error('orcad_destination_output_coverage_authority_changed')
    }
    return destination
  }
  const destination = assertCurrent()
  const coverage = destination.outbox.inspectAppliedCoverage(identity, throughSeq)
  if (assertCurrent().outbox !== destination.outbox) {
    throw new Error('orcad_destination_output_coverage_authority_changed')
  }
  return structuredClone({ ...activation, coverage })
}
