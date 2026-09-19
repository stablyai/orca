import { terminalLayoutAdmissionFixture } from '../persistence/migrating-orcad-catalog/orcad-terminal-layout-admission-test-fixture'
import {
  identity,
  preparation
} from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import { parseOrcadCatalogActivationRequest } from './orcad-catalog-activation-contract'

export function catalogActivationFixture() {
  const { manifest } = terminalLayoutAdmissionFixture('folder')
  const surfaceBinding = preparation.surfacePublication.surfaceBinding
  const request = parseOrcadCatalogActivationRequest({
    identity,
    catalogAdmission: { version: 1, manifest, bindings: [{ identity, surfaceBinding }] },
    publicationReceipt: {
      version: 1,
      bridgeId: identity.bridgeId,
      destinationRuntimeId: identity.destinationRuntimeId,
      publicationReceiptId: 'published',
      surfaceBinding,
      publishedAt: '2026-09-07T00:00:00.000Z',
      commitReceipt: {
        bridgeId: identity.bridgeId,
        receiptId: 'committed',
        acceptedSourceEndSeq: 1,
        committedAt: '2026-09-07T00:00:00.000Z'
      }
    }
  })
  const activation = {
    identity,
    publicationReceipt: request.publicationReceipt,
    destinationClaim: { generation: 1, claimId: 'claim' },
    catalogAdmission: request.catalogAdmission
  }
  const result = {
    version: 1,
    identity,
    publicationReceipt: request.publicationReceipt,
    destinationClaim: activation.destinationClaim,
    catalog: { migrationId: manifest.migrationId, manifestSha256: manifest.manifestSha256 }
  }
  return { request, activation, result }
}
