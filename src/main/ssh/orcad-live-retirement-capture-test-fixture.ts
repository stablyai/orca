import { OrcadOutgoingCaptureStore } from './orcad-outgoing-capture-store'
import { groupOrcadLiveCatalogAdmissions } from './orcad-live-catalog-admissions'
import { digestPtyOwnershipInitialModelSnapshot } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-initial-model-digest'
import type { controlReleaseFixture } from '../persistence-orcad-live-retirement-installation.test'
type Fixture = Awaited<ReturnType<typeof controlReleaseFixture>>

export function seedLiveRetirementCaptures(
  profileDirectory: string,
  f: Pick<Fixture, 'cutover' | 'target'> & {
    released: Pick<Awaited<ReturnType<Fixture['release']>>, 'sourceOutputSettlements'>
  }
) {
  const captures = new OrcadOutgoingCaptureStore(profileDirectory)
  for (const catalogAdmission of groupOrcadLiveCatalogAdmissions(f.cutover)) {
    for (const { identity, surfaceBinding } of catalogAdmission.bindings) {
      const settled = f.released.sourceOutputSettlements.find(
        (entry) => entry.id === identity.terminalId
      )!
      const end = settled.throughSourceEndSu
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
      captures.persist({
        version: 2,
        identity,
        catalogAdmission,
        surfaceBinding,
        destinationEnvironmentId: f.cutover.destinationEnvironmentId,
        sourceSshTargetId: f.target.id,
        sourceSshTargetGeneration: f.cutover.manifest.source.sshTargetGeneration,
        source: {
          version: 1,
          proof: { ...identity, version: 1, credential: 'a'.repeat(64) },
          endpoint: '/seeded-source.sock',
          incumbentVersion: 'build',
          endpointCredential: 'seeded'
        },
        model,
        selection: {
          version: 1,
          modelSha256: digestPtyOwnershipInitialModelSnapshot(model, identity, 1),
          boundary: {
            version: 1,
            identity,
            throughSeq: 1,
            delivery: {
              id: identity.terminalId,
              ptyIncarnation: identity.incarnationId,
              providerGeneration: 77,
              clientGeneration: settled.clientGeneration,
              ownerGeneration: settled.ownerGeneration,
              deliveryToken: settled.deliveryToken,
              state: 'active',
              windowSu: 256,
              receivedEndSu: end,
              sentEndSu: end,
              creditedEndSu: end,
              generationClosed: false,
              exitPublished: false
            }
          }
        }
      })
    }
  }
}
