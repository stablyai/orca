import { liveSourceRetirementFixture } from '../persistence/migrating-orcad-catalog/orcad-live-source-retirement-test-fixture'
import { digestPtyOwnershipInitialModelSnapshot } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-initial-model-digest'
import { createOrcadLiveSourceRetirementRecord } from './orcad-live-source-retirement-record'
import { groupOrcadLiveCatalogAdmissions } from './orcad-live-catalog-admissions'

export function coveredCancellationFixture() {
  const f = liveSourceRetirementFixture()
  const record = createOrcadLiveSourceRetirementRecord({
    ...f,
    release: {
      version: 1,
      cutover: f.cutover,
      activations: f.cutover.terminalPublications!.map((publication) => ({
        version: 1,
        identity: publication.identity,
        publicationReceipt: publication.publicationReceipt,
        destinationClaim: { generation: 1, claimId: 'claim' },
        catalog: publication.catalog
      }))
    }
  })
  const catalogAdmission = groupOrcadLiveCatalogAdmissions(f.cutover)[0]
  const { identity, surfaceBinding } = catalogAdmission.bindings[0]
  const model = {
    version: 1,
    identity,
    throughSeq: 1,
    modelSequenceEnd: 100,
    modelData: 'captured',
    cols: 80,
    rows: 24,
    restoreMetadata: { version: 1 }
  }
  const delivery = {
    id: identity.terminalId,
    ptyIncarnation: identity.incarnationId,
    providerGeneration: 2,
    clientGeneration: 3,
    ownerGeneration: identity.sourceOwnerGeneration,
    deliveryToken: 'token',
    state: 'active',
    windowSu: 256,
    receivedEndSu: 100,
    sentEndSu: 100,
    creditedEndSu: 100,
    generationClosed: false,
    exitPublished: false
  }
  const selection = {
    version: 1,
    modelSha256: digestPtyOwnershipInitialModelSnapshot(model, identity, 1),
    boundary: { version: 1, identity, throughSeq: 1, delivery }
  }
  const capture = {
    version: 2,
    identity,
    catalogAdmission,
    surfaceBinding,
    destinationEnvironmentId: f.cutover.destinationEnvironmentId,
    sourceSshTargetId: f.cutover.manifest.source.sshTargetId,
    sourceSshTargetGeneration: f.cutover.manifest.source.sshTargetGeneration,
    source: {
      version: 1,
      proof: { ...identity, version: 1, credential: 'a'.repeat(64) },
      endpoint: '/seeded-source.sock',
      incumbentVersion: 'build',
      endpointCredential: 'seeded'
    },
    model,
    selection
  }
  const request = {
    version: 1,
    ...identity,
    savedBaseline: structuredClone(selection),
    successorGeneration: identity.sourceOwnerGeneration + 1,
    retirementRecordSha256: record.sha256,
    recoveryOnly: false
  }
  const retirement = {
    version: 1,
    ...identity,
    coveredSourceDeliveryRetirement: {
      phase: 'retired',
      retirementRecordSha256: record.sha256,
      modelSha256: selection.modelSha256,
      sourceOutputEndSeq: 2,
      receipt: structuredClone(f.cutover.terminalPublications![0].publicationReceipt.commitReceipt),
      delivery: { ...delivery, receivedEndSu: 400, sentEndSu: 356 }
    },
    sourceCancellation: { canceled: true, sentEndSu: 356, creditedEndSu: 100 }
  }
  return { record, capture, request, retirement }
}
