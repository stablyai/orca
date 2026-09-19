import { parseOrcadTerminalLayoutAdmission } from '../persistence/migrating-orcad-catalog/orcad-terminal-layout-admission'
import { parsePtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import { parsePtyOwnershipTransferPublicationReceipt } from '../../shared/pty-ownership-transfer-receipt-wire'
import { samePtyOwnershipTransferPublicationReceipt } from '../../shared/pty-ownership-transfer-receipt-validation'
import { samePtyOwnershipTransferSurfaceBinding } from '../../shared/pty-ownership-transfer-surface-binding'
import { parsePtyOwnershipTransferDestinationClaim } from '../../shared/pty-ownership-transfer-destination-claim'

export function parseOrcadCatalogActivationRequest(value: {
  identity: unknown
  publicationReceipt: unknown
  catalogAdmission: unknown
}) {
  const identity = parsePtyOwnershipTransferWireIdentity(value.identity)
  const publicationReceipt = parsePtyOwnershipTransferPublicationReceipt(value.publicationReceipt)
  const catalogAdmission = parseOrcadTerminalLayoutAdmission(value.catalogAdmission)
  if (
    publicationReceipt.bridgeId !== identity.bridgeId ||
    publicationReceipt.destinationRuntimeId !== identity.destinationRuntimeId ||
    !catalogAdmission.bindings.some(
      (entry) =>
        samePtyOwnershipTransferIdentity(entry.identity, identity) &&
        samePtyOwnershipTransferSurfaceBinding(
          entry.surfaceBinding,
          publicationReceipt.surfaceBinding
        )
    )
  ) {
    throw new Error('orcad_catalog_activation_identity_mismatch')
  }
  return { identity, publicationReceipt, catalogAdmission }
}

export function parseOrcadCatalogActivationResult(
  value: unknown,
  expected: ReturnType<typeof parseOrcadCatalogActivationRequest>
) {
  const record = value as Record<string, unknown> | null
  const catalog = record?.catalog as Record<string, unknown> | null
  if (
    record?.version !== 1 ||
    catalog?.migrationId !== expected.catalogAdmission.manifest.migrationId ||
    catalog?.manifestSha256 !== expected.catalogAdmission.manifest.manifestSha256
  ) {
    throw new Error('orcad_catalog_activation_reply_invalid')
  }
  const identity = parsePtyOwnershipTransferWireIdentity(record.identity)
  const publicationReceipt = parsePtyOwnershipTransferPublicationReceipt(record.publicationReceipt)
  const destinationClaim = parsePtyOwnershipTransferDestinationClaim(record.destinationClaim)
  if (
    !samePtyOwnershipTransferIdentity(identity, expected.identity) ||
    !samePtyOwnershipTransferPublicationReceipt(publicationReceipt, expected.publicationReceipt)
  ) {
    throw new Error('orcad_catalog_activation_receipt_mismatch')
  }
  return {
    version: 1 as const,
    identity,
    publicationReceipt,
    destinationClaim,
    catalog: {
      migrationId: expected.catalogAdmission.manifest.migrationId,
      manifestSha256: expected.catalogAdmission.manifest.manifestSha256
    }
  }
}
