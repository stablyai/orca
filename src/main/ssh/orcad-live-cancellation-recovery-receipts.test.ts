import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { coveredCancellationFixture } from './orcad-live-covered-cancellation-test-fixture'
import { bindOrcadLiveCancellationCohort } from './orcad-live-cancellation-cohort'
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
import { inspectOrcadLiveRetirementRecovery } from './orcad-live-retirement-recovery-inspection'
import {
  createOrcadLiveSourceCleanupIntent,
  OrcadLiveSourceCleanupIntentStore
} from './orcad-live-source-cleanup-intent'
import {
  createOrcadLiveCleanupOutputEvidence,
  OrcadLiveCleanupOutputEvidenceStore
} from './orcad-live-cleanup-output-evidence'
import {
  listValidatedOrcadLiveCancellationRecoveryReceipts,
  parseOrcadLiveCancellationRecoveryReceipt
} from './orcad-live-cancellation-recovery-receipts'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-cancellation-recovery-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function ordinaryFixture(f = coveredCancellationFixture()) {
  const bindings = f.record.release.cutover.liveTerminalBindings!
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
  const receipt = createOrcadLiveSourceCancellationReceipt({
    record: f.record,
    settlements,
    retirement: {
      version: 1,
      ...identity,
      sourceDeliveryRetirement: {
        phase: 'retired',
        retirementRecordSha256: f.record.sha256,
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
  return { receipt, settlements }
}

function persistSettlement(f: ReturnType<typeof coveredCancellationFixture>) {
  const ordinary = ordinaryFixture(f)
  new OrcadLiveSourceCleanupIntentStore(root).persist(createOrcadLiveSourceCleanupIntent(f.record))
  new OrcadLiveCleanupOutputEvidenceStore(root).persist(
    createOrcadLiveCleanupOutputEvidence(f.record, ordinary.settlements)
  )
  return ordinary
}

it('dispatches both historical versions and refuses unsupported or cross-labeled records', () => {
  const covered = createOrcadLiveCoveredCancellationReceipt(coveredCancellationFixture())
  const ordinary = ordinaryFixture().receipt
  expect(parseOrcadLiveCancellationRecoveryReceipt(covered)).toEqual(covered)
  expect(parseOrcadLiveCancellationRecoveryReceipt(ordinary)).toEqual(ordinary)
  for (const value of [{ ...covered, version: 1 }, { ...ordinary, version: 2 }, { version: 3 }]) {
    expect(() => parseOrcadLiveCancellationRecoveryReceipt(value)).toThrow()
  }
})

it('discovers covered disk history with exact record and capture without local settlements', () => {
  const f = coveredCancellationFixture()
  const receipt = createOrcadLiveCoveredCancellationReceipt(f)
  new OrcadLiveSourceRetirementRecordStore(root).persist(f.record)
  new OrcadOutgoingCaptureStore(root).persist(f.capture)
  new OrcadLiveCoveredCancellationReceiptStore(root).persist(receipt)
  expect(new OrcadLiveCleanupOutputEvidenceStore(root).list()).toEqual([])
  expect(() => bindOrcadLiveCancellationCohort(root, f.record)).toThrow(
    'orcad_live_cancellation_cohort_incomplete'
  )
  expect(listValidatedOrcadLiveCancellationRecoveryReceipts(root)).toEqual([
    { record: f.record, receipt }
  ])
  const inspection = inspectOrcadLiveRetirementRecovery(root, {
    listOrcadLiveRetirementMarkers: () => [],
    inspectOrcadLiveRetirementProfileState: () => ({ state: 'prepared' as const, record: f.record })
  })[0]
  expect(inspection).toMatchObject({
    state: 'prepared',
    sourceCancellationReceipts: { recorded: 1, total: 2 }
  })
  expect(inspection).not.toHaveProperty('sourceOutputSettlementRecorded')
  expect(inspection).not.toHaveProperty('sourceCompletionPrepared')
  expect(inspection).not.toHaveProperty('sourceRouteRemovalRecorded')
  expect(inspection).not.toHaveProperty('runtimeCleanupRecorded')
})

it.each([
  'missing-capture',
  'wrong-capture',
  'missing-record',
  'wrong-record',
  'duplicate-record'
] as const)('refuses covered history with %s', (kind) => {
  const f = coveredCancellationFixture()
  new OrcadLiveCoveredCancellationReceiptStore(root).persist(
    createOrcadLiveCoveredCancellationReceipt(f)
  )
  if (kind !== 'missing-record') {
    new OrcadLiveSourceRetirementRecordStore(root).persist(f.record)
  }
  if (kind !== 'missing-capture') {
    const capture = structuredClone(f.capture)
    if (kind === 'wrong-capture') {
      capture.selection.boundary.delivery.providerGeneration++
    }
    new OrcadOutgoingCaptureStore(root).persist(capture)
  }
  const records =
    kind === 'wrong-record'
      ? [{ ...f.record, sha256: 'f'.repeat(64) }]
      : kind === 'duplicate-record'
        ? [f.record, f.record]
        : undefined
  expect(() => listValidatedOrcadLiveCancellationRecoveryReceipts(root, records)).toThrow()
})

it('ordinary disk history still needs complete validated settlements', () => {
  const f = coveredCancellationFixture()
  const { receipt } = ordinaryFixture(f)
  new OrcadLiveSourceRetirementRecordStore(root).persist(f.record)
  new OrcadLiveSourceCancellationReceiptStore(root).persist(receipt)
  expect(() => listValidatedOrcadLiveCancellationRecoveryReceipts(root)).toThrow(
    'orcad_live_source_cancellation_receipt_conflict'
  )
  persistSettlement(f)
  expect(listValidatedOrcadLiveCancellationRecoveryReceipts(root)).toEqual([
    { record: f.record, receipt }
  ])
})

it('discovers both versions for different terminals without conflating their evidence', () => {
  const f = coveredCancellationFixture()
  const covered = createOrcadLiveCoveredCancellationReceipt(f)
  new OrcadLiveSourceRetirementRecordStore(root).persist(f.record)
  new OrcadOutgoingCaptureStore(root).persist(f.capture)
  new OrcadLiveCoveredCancellationReceiptStore(root).persist(covered)
  const ordinary = persistSettlement(f).receipt
  new OrcadLiveSourceCancellationReceiptStore(root).persist(ordinary)
  const found = listValidatedOrcadLiveCancellationRecoveryReceipts(root)
  const cohort = bindOrcadLiveCancellationCohort(root, f.record)
  expect(cohort.receipts).toEqual([covered, ordinary])
  expect(() => cohort.assertCancellation(f.record)).not.toThrow()
  expect(found).toHaveLength(2)
  expect(found).toEqual(
    expect.arrayContaining([
      { record: f.record, receipt: covered },
      { record: f.record, receipt: ordinary }
    ])
  )
  expect(() => listValidatedOrcadLiveCancellationRecoveryReceipts(root, [f.record], [])).toThrow(
    'orcad_live_source_cancellation_receipt_conflict'
  )
})

it.each([
  'orcad-live-source-retirement-records',
  'orcad-live-source-cancellation-receipts',
  'orcad-outgoing-captures',
  'orcad-live-source-cleanup-intents',
  'orcad-live-cleanup-output-evidence'
])('retained cohort revalidates %s instead of trusting its snapshot', (directory) => {
  const f = coveredCancellationFixture()
  new OrcadLiveSourceRetirementRecordStore(root).persist(f.record)
  new OrcadOutgoingCaptureStore(root).persist(f.capture)
  new OrcadLiveCoveredCancellationReceiptStore(root).persist(
    createOrcadLiveCoveredCancellationReceipt(f)
  )
  new OrcadLiveSourceCancellationReceiptStore(root).persist(persistSettlement(f).receipt)
  const cohort = bindOrcadLiveCancellationCohort(root, f.record)
  rmSync(join(root, directory), { recursive: true })
  expect(() => cohort.assertCancellation(f.record)).toThrow()
})
