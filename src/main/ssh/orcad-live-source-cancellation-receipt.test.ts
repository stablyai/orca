import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  createOrcadLiveSourceCancellationReceipt,
  listValidatedOrcadLiveSourceCancellationReceipts,
  OrcadLiveSourceCancellationReceiptStore
} from './orcad-live-source-cancellation-receipt'
import { restoreOutgoingOrcadPreparationAdmission } from './orcad-outgoing-preparation-startup'
import { inspectOrcadLiveRetirementRecovery } from './orcad-live-retirement-recovery-inspection'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-source-cancellation-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function fixture() {
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
  const identity = record.release.cutover.liveTerminalBindings![0].identity
  const retirement = {
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
        deliveryToken: 'token-0',
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
  const cancellation = { canceled: true, sentEndSu: 104, creditedEndSu: 104 }
  new OrcadLiveSourceRetirementRecordStore(root).persist(record)
  new OrcadLiveSourceCleanupIntentStore(root).persist(createOrcadLiveSourceCleanupIntent(record))
  new OrcadLiveCleanupOutputEvidenceStore(root).persist(
    createOrcadLiveCleanupOutputEvidence(record, settlements)
  )
  return { record, settlements, retirement, cancellation }
}

it('persists exact per-terminal receipt without conflating local and host generations', () => {
  const f = fixture()
  const receipt = createOrcadLiveSourceCancellationReceipt(f)
  const store = new OrcadLiveSourceCancellationReceiptStore(root)
  expect(store.persist(receipt)).toEqual(receipt)
  expect(store.persist(receipt)).toEqual(receipt)
  expect(new OrcadLiveSourceCancellationReceiptStore(root).read(receipt.identity)).toEqual(receipt)
  expect(listValidatedOrcadLiveSourceCancellationReceipts(root)).toEqual([
    { record: f.record, receipt }
  ])
})

it('reports validated historical receipt progress without claiming catalog retirement', () => {
  const f = fixture()
  const store = {
    listOrcadLiveRetirementMarkers: () => [],
    inspectOrcadLiveRetirementProfileState: () => ({ state: 'prepared' as const, record: f.record })
  }
  expect(inspectOrcadLiveRetirementRecovery(root, store)[0]).not.toHaveProperty(
    'sourceCancellationReceipts'
  )
  new OrcadLiveSourceCancellationReceiptStore(root).persist(
    createOrcadLiveSourceCancellationReceipt(f)
  )
  expect(inspectOrcadLiveRetirementRecovery(root, store)[0]).toMatchObject({
    state: 'prepared',
    sourceCancellationReceipts: { recorded: 1, total: 2 }
  })
  const identity = f.record.release.cutover.liveTerminalBindings![1].identity
  new OrcadLiveSourceCancellationReceiptStore(root).persist(
    createOrcadLiveSourceCancellationReceipt({
      ...f,
      retirement: {
        ...f.retirement,
        ...identity,
        sourceDeliveryRetirement: {
          ...f.retirement.sourceDeliveryRetirement,
          delivery: {
            ...f.retirement.sourceDeliveryRetirement.delivery,
            id: identity.terminalId,
            ptyIncarnation: identity.incarnationId,
            deliveryToken: f.settlements[1].deliveryToken
          }
        }
      }
    })
  )
  expect(inspectOrcadLiveRetirementRecovery(root, store)[0]).toMatchObject({
    state: 'prepared',
    sourceCancellationReceipts: { recorded: 2, total: 2 }
  })
  const outputs = vi
    .spyOn(OrcadLiveCleanupOutputEvidenceStore.prototype, 'list')
    .mockReturnValue([])
  try {
    expect(() => inspectOrcadLiveRetirementRecovery(root, store)).toThrow('receipt_conflict')
  } finally {
    outputs.mockRestore()
  }
})

it('retains host cancellation evidence without adding it to transfer identity', () => {
  const f = fixture()
  const receipt = createOrcadLiveSourceCancellationReceipt({
    ...f,
    retirement: { ...f.retirement, sourceCancellation: f.cancellation }
  })
  expect(receipt.identity).not.toHaveProperty('sourceCancellation')
  expect(receipt.retirement.sourceCancellation).toEqual(f.cancellation)
  const store = new OrcadLiveSourceCancellationReceiptStore(root)
  expect(store.persist(receipt)).toEqual(receipt)
  expect(listValidatedOrcadLiveSourceCancellationReceipts(root)).toEqual([
    { record: f.record, receipt }
  ])
})

it.each(['hash', 'identity', 'token', 'client', 'cursor', 'cancellation', 'phase'] as const)(
  'refuses mismatched %s evidence',
  (kind) => {
    const f = fixture()
    const retired = f.retirement.sourceDeliveryRetirement
    if (kind === 'hash') {
      retired.retirementRecordSha256 = 'f'.repeat(64)
    }
    if (kind === 'identity') {
      f.retirement.bridgeId = 'other'
    }
    if (kind === 'token') {
      retired.delivery.deliveryToken = 'other'
    }
    if (kind === 'client') {
      retired.delivery.clientGeneration++
    }
    if (kind === 'cursor') {
      f.settlements[0].throughSourceEndSu--
    }
    if (kind === 'cancellation') {
      f.cancellation.creditedEndSu--
    }
    if (kind === 'phase') {
      retired.phase = 'prepared'
    }
    expect(() => createOrcadLiveSourceCancellationReceipt(f)).toThrow()
    expect(new OrcadLiveSourceCancellationReceiptStore(root).list()).toEqual([])
  }
)

it('strips credentials and unrelated host fields from durable receipt', () => {
  const f = fixture()
  const receipt = createOrcadLiveSourceCancellationReceipt({
    ...f,
    retirement: { ...f.retirement, credential: 'secret' },
    cancellation: { ...f.cancellation, credential: 'secret' }
  })
  expect(JSON.stringify(receipt)).not.toContain('secret')
})

it('rejects conflicting retries and orphan receipts', () => {
  const f = fixture()
  const receipt = createOrcadLiveSourceCancellationReceipt(f)
  const store = new OrcadLiveSourceCancellationReceiptStore(root)
  store.persist(receipt)
  expect(() => store.persist({ ...receipt, migrationId: 'other' })).toThrow('conflict')
  const isolated = join(root, 'isolated')
  new OrcadLiveSourceCancellationReceiptStore(isolated).persist(receipt)
  expect(() => listValidatedOrcadLiveSourceCancellationReceipts(isolated)).toThrow('conflict')
})

it('refuses orphan receipts before provider admission mutates transport', async () => {
  const receipt = createOrcadLiveSourceCancellationReceipt(fixture())
  const isolated = join(root, 'isolated')
  new OrcadLiveSourceCancellationReceiptStore(isolated).persist(receipt)
  const mux = {
    fencePtyControlsAndDrain: vi.fn(async () => {}),
    fencePtyPreparationSurface: vi.fn(),
    fencePtyCatalogCreation: vi.fn()
  }
  await expect(restoreOutgoingOrcadPreparationAdmission('target', mux, isolated)).rejects.toThrow(
    'conflict'
  )
  expect(mux.fencePtyControlsAndDrain).not.toHaveBeenCalled()
  expect(mux.fencePtyPreparationSurface).not.toHaveBeenCalled()
  expect(mux.fencePtyCatalogCreation).not.toHaveBeenCalled()
})
