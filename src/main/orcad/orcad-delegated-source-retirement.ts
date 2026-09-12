import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import { parsePtyOwnershipTransferDestinationClaim } from '../../shared/pty-ownership-transfer-destination-claim'
import { parsePtyOwnershipTransferSourceRetirementRequest } from '../../shared/pty-ownership-transfer-source-retirement'
import { inspectOrcadPublishedDestinationActivation } from './orcad-delegated-activation'

/** Retires source delivery, not the destination connection, terminal or catalog. */
export async function retireOrcadPublishedSourceDelivery(
  options: Parameters<typeof inspectOrcadPublishedDestinationActivation>[0] & {
    retirementRecordSha256: string
    expectedDelivery: unknown
    recoveryOnly?: boolean
    assertAuthority?: () => void
    assertActivation?: (
      activation: Awaited<ReturnType<typeof inspectOrcadPublishedDestinationActivation>>
    ) => void
  }
) {
  const { identity, connection, registry, supervisor, signal } = options
  options.assertAuthority?.()
  const request = parsePtyOwnershipTransferSourceRetirementRequest({
    ...connection.proof,
    retirementRecordSha256: options.retirementRecordSha256,
    ...(options.recoveryOnly === undefined ? {} : { recoveryOnly: options.recoveryOnly })
  })
  const activation = await inspectOrcadPublishedDestinationActivation(options)
  options.assertAuthority?.()
  options.assertActivation?.(activation)
  if (
    !samePtyOwnershipTransferIdentity(request, identity) ||
    request.destinationClaim.generation !== activation.destinationClaim.generation ||
    request.destinationClaim.claimId !== activation.destinationClaim.claimId
  ) {
    throw new Error('orcad_delegated_source_retirement_authority_changed')
  }
  const expected = serializeOrcadMigrationValue({
    publication: activation.publicationReceipt,
    catalog: activation.catalogAdmission,
    claim: activation.destinationClaim
  })
  const assertCurrent = () => {
    signal.throwIfAborted()
    options.assertAuthority?.()
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
      throw new Error('orcad_delegated_source_retirement_authority_changed')
    }
  }
  assertCurrent()
  const result = await connection.client.retireSourceDelivery(
    request,
    options.expectedDelivery,
    { signal },
    assertCurrent
  )
  assertCurrent()
  if (options.recoveryOnly && !result.sourceCancellation) {
    throw new Error('pty_source_retirement_cancellation_required')
  }
  return result
}
