import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as secure from '../../shared/secure-file'
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
  parseOrcadLiveSourceRouteCheckpoint,
  OrcadLiveSourceRouteCheckpointStore,
  listValidatedOrcadLiveSourceRouteCheckpoints
} from './orcad-live-source-route-checkpoint'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-source-route-checkpoint-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const f = liveSourceRetirementFixture()
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
  const checkpoint = createOrcadLiveRuntimeCleanupCheckpoint(record)
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
    checkpoint,
    settlements,
    receipts
  })
  const persistDependencies = () => {
    new OrcadLiveSourceRetirementRecordStore(root).persist(record)
    new OrcadLiveSourceCleanupIntentStore(root).persist(createOrcadLiveSourceCleanupIntent(record))
    new OrcadLiveCleanupOutputEvidenceStore(root).persist(
      createOrcadLiveCleanupOutputEvidence(record, settlements)
    )
    new OrcadLiveRuntimeCleanupCheckpointStore(root).persist(checkpoint)
    for (const receipt of receipts) {
      new OrcadLiveSourceCancellationReceiptStore(root).persist(receipt)
    }
    new OrcadLiveSourceCompletionPreparationStore(root).persist(preparation)
  }
  return {
    record,
    preparation,
    persistDependencies,
    checkpoint: createOrcadLiveSourceRouteCheckpoint(preparation),
    store: new OrcadLiveSourceRouteCheckpointStore(root)
  }
}

it('binds the full preparation by digest without mutating its input', () => {
  const f = fixture()
  expect(f.checkpoint).toEqual({
    ...f.preparation.checkpoint,
    phase: 'source-routes-removed',
    completionPreparationSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
  })
  expect(f.preparation.phase).toBe('source-completion-prepared')
  expect(parseOrcadLiveSourceRouteCheckpoint(f.checkpoint)).toEqual(f.checkpoint)
  expect(() => parseOrcadLiveSourceRouteCheckpoint(f.preparation)).toThrow()
  expect(() => createOrcadLiveSourceRouteCheckpoint(f.checkpoint)).toThrow()
})

it.each(['identity', 'digest', 'preparation-digest', 'phase'] as const)(
  'rejects malformed %s binding',
  (field) => {
    const f = fixture()
    const changed = structuredClone(f.checkpoint)
    if (field === 'identity') {
      changed.identity = { ...changed.identity, ownerLease: '' }
    }
    if (field === 'digest') {
      changed.retirementRecordSha256 = 'invalid'
    }
    if (field === 'preparation-digest') {
      changed.completionPreparationSha256 = 'invalid'
    }
    expect(() =>
      parseOrcadLiveSourceRouteCheckpoint(
        field === 'phase' ? { ...changed, phase: 'source-retired' } : changed
      )
    ).toThrow()
  }
)

it('validates the entire dependency chain by default and refuses orphaned checkpoints', () => {
  const f = fixture()
  f.store.persist(f.checkpoint)
  expect(() => listValidatedOrcadLiveSourceRouteCheckpoints(root)).toThrow('conflict')
  f.persistDependencies()
  expect(listValidatedOrcadLiveSourceRouteCheckpoints(root)).toEqual([
    { record: f.record, checkpoint: f.checkpoint }
  ])
  vi.spyOn(OrcadLiveSourceCancellationReceiptStore.prototype, 'read').mockReturnValue(null)
  expect(() => listValidatedOrcadLiveSourceRouteCheckpoints(root)).toThrow('receipt_conflict')
})

it('requires exactly one matching validated preparation', () => {
  const f = fixture()
  f.store.persist(f.checkpoint)
  const entry = { record: f.record, preparation: f.preparation }
  expect(() => listValidatedOrcadLiveSourceRouteCheckpoints(root, [])).toThrow('conflict')
  expect(() => listValidatedOrcadLiveSourceRouteCheckpoints(root, [entry, entry])).toThrow(
    'conflict'
  )
})

it('refuses a structurally valid checkpoint that differs from the exact preparation', () => {
  const f = fixture()
  const preparation = structuredClone(f.preparation)
  const retirement = preparation.receipts[0].retirement.sourceDeliveryRetirement
  preparation.receipts[0] = {
    ...preparation.receipts[0],
    retirement: {
      ...preparation.receipts[0].retirement,
      sourceDeliveryRetirement: {
        ...retirement,
        delivery: { ...retirement.delivery, windowSu: retirement.delivery.windowSu + 1 }
      }
    }
  }
  const changed = createOrcadLiveSourceRouteCheckpoint(preparation)
  expect(changed.completionPreparationSha256).not.toBe(f.checkpoint.completionPreparationSha256)
  f.store.persist(changed)
  expect(() =>
    listValidatedOrcadLiveSourceRouteCheckpoints(root, [
      { record: f.record, preparation: f.preparation }
    ])
  ).toThrow('conflict')
  expect(() => f.store.persist(f.checkpoint)).toThrow('conflict')
})

it('canonicalizes object key order while binding the entire receipt cohort', () => {
  const f = fixture()
  const reordered = Object.fromEntries(Object.entries(f.preparation).toReversed())
  expect(createOrcadLiveSourceRouteCheckpoint(reordered)).toEqual(f.checkpoint)
  const changed = structuredClone(f.preparation)
  const retirement = changed.receipts[1].retirement.sourceDeliveryRetirement
  changed.receipts[1] = {
    ...changed.receipts[1],
    retirement: {
      ...changed.receipts[1].retirement,
      sourceDeliveryRetirement: {
        ...retirement,
        delivery: { ...retirement.delivery, windowSu: retirement.delivery.windowSu + 1 }
      }
    }
  }
  expect(createOrcadLiveSourceRouteCheckpoint(changed).completionPreparationSha256).not.toBe(
    f.checkpoint.completionPreparationSha256
  )
})

it('reflushes after an uncertain durable write and never acknowledges the failed write', () => {
  const f = fixture()
  const original = secure.writeDurableSecureJsonFile
  const write = vi.spyOn(secure, 'writeDurableSecureJsonFile').mockImplementationOnce((...args) => {
    original(...args)
    throw new Error('write uncertain')
  })
  expect(() => f.store.persist(f.checkpoint)).toThrow('write uncertain')
  expect(f.store.read(f.checkpoint.identity)).toEqual(f.checkpoint)
  expect(f.store.persist(f.checkpoint)).toEqual(f.checkpoint)
  expect(write).toHaveBeenCalledTimes(2)
})
