import { liveSourceRetirementFixture } from '../persistence/migrating-orcad-catalog/orcad-live-source-retirement-test-fixture'
import {
  createOrcadLiveSourceRetirementRecord,
  OrcadLiveSourceRetirementRecordStore
} from './orcad-live-source-retirement-record'
import {
  createOrcadLiveSourceCleanupIntent,
  OrcadLiveSourceCleanupIntentStore
} from './orcad-live-source-cleanup-intent'
import {
  createOrcadLiveCleanupOutputEvidence,
  OrcadLiveCleanupOutputEvidenceStore
} from './orcad-live-cleanup-output-evidence'
import {
  createOrcadLiveRuntimeCleanupCheckpoint,
  OrcadLiveRuntimeCleanupCheckpointStore
} from './orcad-live-runtime-cleanup-checkpoint'
import {
  createOrcadLiveSourceCancellationReceipt,
  OrcadLiveSourceCancellationReceiptStore
} from './orcad-live-source-cancellation-receipt'
import {
  createOrcadLiveSourceCompletionPreparation,
  OrcadLiveSourceCompletionPreparationStore
} from './orcad-live-source-completion-preparation'
import {
  createOrcadLiveSourceRouteCheckpoint,
  OrcadLiveSourceRouteCheckpointStore
} from './orcad-live-source-route-checkpoint'

export function liveSourceCompletionEvidenceFixture(root: string, kind: 'folder' | 'worktree') {
  const f = liveSourceRetirementFixture(kind)
  const record = createOrcadLiveSourceRetirementRecord({
    ...f,
    release: {
      version: 1,
      cutover: f.cutover,
      activations: f.cutover.terminalPublications!.map((entry) => ({
        version: 1,
        identity: entry.identity,
        publicationReceipt: entry.publicationReceipt,
        destinationClaim: { generation: 1, claimId: 'claim' },
        catalog: entry.catalog
      }))
    }
  })
  const runtimeCheckpoint = createOrcadLiveRuntimeCleanupCheckpoint(record)
  const settlements = record.release.cutover.liveTerminalBindings!.map(({ identity }, index) => ({
    id: identity.terminalId,
    ptyIncarnation: identity.incarnationId,
    ownerGeneration: identity.sourceOwnerGeneration,
    providerGeneration: 901,
    clientGeneration: 3,
    deliveryToken: `token-${index}`,
    fromSourceEndSu: 100,
    throughSourceEndSu: 104
  }))
  const receipts = record.release.cutover.liveTerminalBindings!.map(({ identity }, index) =>
    createOrcadLiveSourceCancellationReceipt({
      record,
      settlements,
      cancellation: { canceled: true, sentEndSu: 104, creditedEndSu: 104 },
      retirement: {
        ...identity,
        version: 1,
        sourceDeliveryRetirement: {
          phase: 'retired',
          retirementRecordSha256: record.sha256,
          delivery: {
            id: identity.terminalId,
            ptyIncarnation: identity.incarnationId,
            providerGeneration: 2,
            clientGeneration: 3,
            ownerGeneration: identity.sourceOwnerGeneration,
            deliveryToken: settlements[index].deliveryToken,
            state: 'active',
            windowSu: 256,
            receivedEndSu: 104,
            sentEndSu: 104,
            creditedEndSu: 104,
            generationClosed: false,
            exitPublished: false
          }
        }
      }
    })
  )
  const preparation = createOrcadLiveSourceCompletionPreparation({
    record,
    checkpoint: runtimeCheckpoint,
    settlements,
    receipts
  })
  const checkpoint = createOrcadLiveSourceRouteCheckpoint(preparation)
  const persist = () => {
    new OrcadLiveSourceRetirementRecordStore(root).persist(record)
    new OrcadLiveSourceCleanupIntentStore(root).persist(createOrcadLiveSourceCleanupIntent(record))
    new OrcadLiveCleanupOutputEvidenceStore(root).persist(
      createOrcadLiveCleanupOutputEvidence(record, settlements)
    )
    new OrcadLiveRuntimeCleanupCheckpointStore(root).persist(runtimeCheckpoint)
    for (const receipt of receipts) {
      new OrcadLiveSourceCancellationReceiptStore(root).persist(receipt)
    }
    new OrcadLiveSourceCompletionPreparationStore(root).persist(preparation)
    new OrcadLiveSourceRouteCheckpointStore(root).persist(checkpoint)
  }
  return {
    record,
    committed: record.release.cutover,
    preparation,
    settlements,
    checkpoint,
    persist
  }
}
