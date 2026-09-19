import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as secure from '../../shared/secure-file'
import { restoreOutgoingOrcadPreparationAdmission } from './orcad-outgoing-preparation-startup'
import {
  getProviderForPty,
  registerSshPtyProvider,
  unregisterSshPtyProvider
} from '../ipc/pty/provider/registry'
import type { IPtyProvider } from '../providers/types'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import {
  createOrcadLiveSourceRouteCheckpoint,
  OrcadLiveSourceRouteCheckpointStore
} from './orcad-live-source-route-checkpoint'
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
  parseOrcadLiveSourceCompletionPreparation,
  OrcadLiveSourceCompletionPreparationStore,
  listValidatedOrcadLiveSourceCompletionPreparations
} from './orcad-live-source-completion-preparation'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-completion-preparation-'))
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
  const args = { record, checkpoint, settlements, receipts }
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
  }
  return {
    ...f,
    args,
    persistDependencies,
    store: new OrcadLiveSourceCompletionPreparationStore(root)
  }
}

it('canonicalizes the complete receipt cohort without mutating profile or claiming completion', () => {
  const f = fixture()
  const before = structuredClone(f.state)
  const prepared = createOrcadLiveSourceCompletionPreparation({
    ...f.args,
    receipts: f.args.receipts.toReversed()
  })
  expect(prepared.receipts).toEqual(f.args.receipts)
  expect(prepared.phase).toBe('source-completion-prepared')
  expect(prepared.retirementRecordSha256).toBe(f.args.record.sha256)
  expect(f.state).toEqual(before)
  expect(() =>
    parseOrcadLiveSourceCompletionPreparation({ ...prepared, phase: 'source-retired' })
  ).toThrow()
})

it.each(['missing', 'duplicate', 'foreign', 'settlement', 'checkpoint'] as const)(
  'rejects %s cohort evidence',
  (mode) => {
    const f = fixture()
    const args = structuredClone(f.args)
    if (mode === 'missing') {
      args.receipts.pop()
    }
    if (mode === 'duplicate') {
      args.receipts[1] = args.receipts[0]
    }
    if (mode === 'foreign') {
      args.receipts[0].migrationId = 'foreign'
    }
    if (mode === 'settlement') {
      args.settlements[0].deliveryToken = 'replacement'
    }
    if (mode === 'checkpoint') {
      args.checkpoint.retirementRecordSha256 = 'b'.repeat(64)
    }
    expect(() => createOrcadLiveSourceCompletionPreparation(args)).toThrow()
  }
)

it('persists/reloads immutable preparation only with all referenced evidence intact', () => {
  const f = fixture()
  const prepared = createOrcadLiveSourceCompletionPreparation(f.args)
  f.store.persist(prepared)
  expect(() => listValidatedOrcadLiveSourceCompletionPreparations(root)).toThrow('orphaned')
  f.persistDependencies()
  expect(listValidatedOrcadLiveSourceCompletionPreparations(root)).toEqual([
    { record: f.args.record, preparation: prepared }
  ])
  const changed = structuredClone(prepared)
  const receipt = changed.receipts[0]
  const retirement = receipt.retirement.sourceDeliveryRetirement
  changed.receipts[0] = {
    ...receipt,
    retirement: {
      ...receipt.retirement,
      sourceDeliveryRetirement: {
        ...retirement,
        delivery: { ...retirement.delivery, windowSu: retirement.delivery.windowSu + 1 }
      }
    }
  }
  expect(() => f.store.persist(changed)).toThrow('conflict')
})

it.each(['checkpoint', 'receipt'] as const)('refuses a missing referenced %s', (missing) => {
  const f = fixture()
  f.persistDependencies()
  f.store.persist(createOrcadLiveSourceCompletionPreparation(f.args))
  if (missing === 'checkpoint') {
    expect(() => listValidatedOrcadLiveSourceCompletionPreparations(root, undefined, [])).toThrow(
      'orphaned'
    )
  } else {
    vi.spyOn(OrcadLiveSourceCancellationReceiptStore.prototype, 'read').mockReturnValue(null)
    expect(() => listValidatedOrcadLiveSourceCompletionPreparations(root)).toThrow(
      'receipt_conflict'
    )
  }
})

it('restores durable source refusal before a replacement provider is published', async () => {
  const f = fixture()
  f.persistDependencies()
  f.store.persist(createOrcadLiveSourceCompletionPreparation(f.args))
  new OrcadLiveSourceRouteCheckpointStore(root).persist(
    createOrcadLiveSourceRouteCheckpoint(createOrcadLiveSourceCompletionPreparation(f.args))
  )
  const target = f.args.record.release.cutover.manifest.source.sshTargetId
  const mux = {
    fencePtyControlsAndDrain: vi.fn().mockResolvedValue(undefined),
    fencePtyPreparationSurface: vi.fn(),
    fencePtyCatalogCreation: vi.fn()
  }
  await restoreOutgoingOrcadPreparationAdmission(target, mux, root)
  const replacement = {} as IPtyProvider
  registerSshPtyProvider(target, replacement)
  try {
    for (const receipt of f.args.receipts) {
      expect(() => getProviderForPty(toAppSshPtyId(target, receipt.identity.terminalId))).toThrow(
        'source_control_released'
      )
    }
    expect(getProviderForPty(toAppSshPtyId(target, 'unrelated-sibling'))).toBe(replacement)
  } finally {
    unregisterSshPtyProvider(target)
  }
})

it('reflushes readable preparation after an uncertain write without accepting failed acknowledgment', () => {
  const f = fixture()
  const prepared = createOrcadLiveSourceCompletionPreparation(f.args)
  const original = secure.writeDurableSecureJsonFile
  const write = vi.spyOn(secure, 'writeDurableSecureJsonFile').mockImplementationOnce((...args) => {
    original(...args)
    throw new Error('write uncertain')
  })
  expect(() => f.store.persist(prepared)).toThrow('write uncertain')
  expect(f.store.read(prepared.identity)).toEqual(prepared)
  expect(f.store.persist(prepared)).toEqual(prepared)
  expect(write).toHaveBeenCalledTimes(2)
})
