import { unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { coveredCancellationFixture } from './orcad-live-covered-cancellation-test-fixture'
import {
  createOrcadLiveCoveredCancellationReceipt,
  OrcadLiveCoveredCancellationReceiptStore
} from './orcad-live-covered-cancellation-receipt'
import {
  createOrcadLiveSourceCancellationReceipt,
  OrcadLiveSourceCancellationReceiptStore
} from './orcad-live-source-cancellation-receipt'
import { OrcadLiveSourceRetirementRecordStore } from './orcad-live-source-retirement-record'
import { OrcadOutgoingCaptureStore } from './orcad-outgoing-capture-store'
import {
  createOrcadLiveSourceCleanupIntent,
  OrcadLiveSourceCleanupIntentStore
} from './orcad-live-source-cleanup-intent'
import {
  createOrcadLiveCleanupOutputEvidence,
  OrcadLiveCleanupOutputEvidenceStore
} from './orcad-live-cleanup-output-evidence'
import {
  createOrcadLiveAppliedCoverageEvidence,
  bindOrcadLiveAppliedCoverageEvidence,
  OrcadLiveAppliedCoverageEvidenceStore
} from './orcad-live-applied-coverage-evidence'

export function appliedCoverageFixture(root: string) {
  const f = coveredCancellationFixture()
  const { record } = f
  new OrcadLiveSourceRetirementRecordStore(root).persist(record)
  new OrcadOutgoingCaptureStore(root).persist(f.capture)
  new OrcadLiveCoveredCancellationReceiptStore(root).persist(
    createOrcadLiveCoveredCancellationReceipt(f)
  )
  const bindings = record.release.cutover.liveTerminalBindings!
  const identity = bindings[1].identity
  const settlements = bindings.map(({ identity }) => ({
    id: identity.terminalId,
    ptyIncarnation: identity.incarnationId,
    providerGeneration: 91,
    clientGeneration: 3,
    ownerGeneration: identity.sourceOwnerGeneration,
    deliveryToken: 'token',
    fromSourceEndSu: 100,
    throughSourceEndSu: 100
  }))
  new OrcadLiveSourceCleanupIntentStore(root).persist(createOrcadLiveSourceCleanupIntent(record))
  new OrcadLiveCleanupOutputEvidenceStore(root).persist(
    createOrcadLiveCleanupOutputEvidence(record, settlements)
  )
  new OrcadLiveSourceCancellationReceiptStore(root).persist(
    createOrcadLiveSourceCancellationReceipt({
      record,
      settlements,
      retirement: {
        version: 1,
        ...identity,
        sourceDeliveryRetirement: {
          phase: 'retired',
          retirementRecordSha256: record.sha256,
          delivery: {
            ...f.capture.selection.boundary.delivery,
            id: identity.terminalId,
            ptyIncarnation: identity.incarnationId,
            ownerGeneration: identity.sourceOwnerGeneration
          }
        }
      },
      cancellation: { canceled: true, sentEndSu: 100, creditedEndSu: 100 }
    })
  )
  const throughSeq = f.retirement.coveredSourceDeliveryRetirement.sourceOutputEndSeq
  const coverage = {
    ...record.release.activations[0],
    coverage: {
      throughSeq,
      acknowledgedEndSeq: throughSeq,
      modelThroughSeq: throughSeq,
      modelSequenceEnd: 400
    }
  }
  const create = (coverages: readonly unknown[] = [coverage]) =>
    createOrcadLiveAppliedCoverageEvidence({ profileDirectory: root, record, coverages })
  const evidenceStore = new OrcadLiveAppliedCoverageEvidenceStore(root)
  const bind = () => bindOrcadLiveAppliedCoverageEvidence(root, record)
  const remove = (directory: string, bridgeId = record.identity.bridgeId) => {
    const key = createHash('sha256').update(bridgeId).digest('hex')
    unlinkSync(join(root, directory, `${key}.json`))
  }
  return { ...f, coverage, create, bind, evidenceStore, remove }
}
