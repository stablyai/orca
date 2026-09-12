import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { coveredCancellationFixture } from './orcad-live-covered-cancellation-test-fixture'
import {
  createOrcadLiveCoveredCancellationReceipt,
  OrcadLiveCoveredCancellationReceiptStore,
  parseOrcadLiveCoveredCancellationReceipt,
  validateOrcadLiveCoveredCancellationReceipt
} from './orcad-live-covered-cancellation-receipt'
import { OrcadLiveSourceCancellationReceiptStore } from './orcad-live-source-cancellation-receipt'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-covered-receipt-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

it('binds unacknowledged and unsent custody to the exact capture and publication', () => {
  const f = coveredCancellationFixture()
  const receipt = createOrcadLiveCoveredCancellationReceipt(f)
  expect(receipt.request.retirementRecordSha256).toBe(f.record.sha256)
  expect(receipt.request.savedBaseline).toEqual(f.capture.selection)
  expect(receipt.retirement.coveredSourceDeliveryRetirement).toMatchObject({
    receipt: f.record.release.cutover.terminalPublications![0].publicationReceipt.commitReceipt,
    delivery: { receivedEndSu: 400, sentEndSu: 356, creditedEndSu: 100 }
  })
  expect(receipt).not.toHaveProperty('authority')
  expect(JSON.stringify(receipt)).not.toContain('seeded')
  expect(JSON.stringify(receipt)).not.toContain('credential')
})

it.each([
  'hash',
  'baseline',
  'catalog',
  'environment',
  'target',
  'generation',
  'commit',
  'cancel',
  'identity'
] as const)('refuses changed %s evidence', (kind) => {
  const f = coveredCancellationFixture()
  if (kind === 'hash') {
    f.request.retirementRecordSha256 = 'f'.repeat(64)
    f.retirement.coveredSourceDeliveryRetirement.retirementRecordSha256 =
      f.request.retirementRecordSha256
  }
  if (kind === 'baseline') {
    f.capture.selection.boundary.delivery.providerGeneration++
  }
  if (kind === 'catalog') {
    f.capture.catalogAdmission = {
      ...f.capture.catalogAdmission,
      bindings: f.capture.catalogAdmission.bindings.slice(0, -1)
    }
  }
  if (kind === 'environment') {
    f.capture.destinationEnvironmentId = 'other'
  }
  if (kind === 'target') {
    f.capture.sourceSshTargetId = 'other'
  }
  if (kind === 'generation') {
    f.capture.sourceSshTargetGeneration = (f.capture.sourceSshTargetGeneration ?? 0) + 1
  }
  if (kind === 'commit') {
    f.retirement.coveredSourceDeliveryRetirement.receipt.receiptId = 'other'
  }
  if (kind === 'cancel') {
    f.retirement.sourceCancellation.creditedEndSu++
  }
  if (kind === 'identity') {
    f.retirement.bridgeId = 'other'
  }
  expect(() => createOrcadLiveCoveredCancellationReceipt(f)).toThrow()
})

it('round trips on disk, reflushes exact retries and preserves the first conflicting receipt', () => {
  const receipt = createOrcadLiveCoveredCancellationReceipt(coveredCancellationFixture())
  const store = new OrcadLiveCoveredCancellationReceiptStore(root)
  expect(store.persist(receipt)).toEqual(receipt)
  expect(store.persist(receipt)).toEqual(receipt)
  expect(new OrcadLiveCoveredCancellationReceiptStore(root).list()).toEqual([receipt])
  expect(() => store.persist({ ...receipt, migrationId: 'other' })).toThrow('conflict')
  expect(store.read(receipt.identity)).toEqual(receipt)
})

it('revalidates persisted evidence against the cohort, not merely its parseable shape', () => {
  const f = coveredCancellationFixture()
  const receipt = createOrcadLiveCoveredCancellationReceipt(f)
  expect(validateOrcadLiveCoveredCancellationReceipt(receipt, f.record, f.capture)).toEqual(receipt)
  const altered = { ...receipt, migrationId: 'other' }
  expect(parseOrcadLiveCoveredCancellationReceipt(altered).migrationId).toBe('other')
  expect(() => validateOrcadLiveCoveredCancellationReceipt(altered, f.record, f.capture)).toThrow()
})

function ordinaryReceipt() {
  const f = coveredCancellationFixture()
  const delivery = f.capture.selection.boundary.delivery
  return {
    version: 1,
    phase: 'source-cancellation-confirmed',
    migrationId: f.record.release.cutover.manifest.migrationId,
    retirement: {
      version: 1,
      ...f.capture.identity,
      sourceDeliveryRetirement: {
        phase: 'retired',
        retirementRecordSha256: f.record.sha256,
        delivery
      }
    },
    cancellation: { canceled: true, sentEndSu: 100, creditedEndSu: 100 }
  }
}

it('ordinary readers refuse covered records in the shared namespace without overwriting', () => {
  const receipt = createOrcadLiveCoveredCancellationReceipt(coveredCancellationFixture())
  const covered = new OrcadLiveCoveredCancellationReceiptStore(root)
  covered.persist(receipt)
  const ordinary = new OrcadLiveSourceCancellationReceiptStore(root)
  expect(() => ordinary.read(receipt.identity)).toThrow()
  expect(() => ordinary.list()).toThrow()
  expect(() => ordinary.persist(ordinaryReceipt())).toThrow()
  expect(covered.read(receipt.identity)).toEqual(receipt)
})

it('covered readers refuse ordinary records in the shared namespace without overwriting', () => {
  const ordinary = new OrcadLiveSourceCancellationReceiptStore(root)
  const saved = ordinary.persist(ordinaryReceipt())
  const covered = new OrcadLiveCoveredCancellationReceiptStore(root)
  expect(() => covered.read(saved.identity)).toThrow()
  expect(() => covered.list()).toThrow()
  expect(() =>
    covered.persist(createOrcadLiveCoveredCancellationReceipt(coveredCancellationFixture()))
  ).toThrow()
  expect(ordinary.read(saved.identity)).toEqual(saved)
})

it('rejects receipt identity changes and strips unrelated authority claims', () => {
  const receipt = createOrcadLiveCoveredCancellationReceipt(coveredCancellationFixture())
  expect(() =>
    parseOrcadLiveCoveredCancellationReceipt({
      ...receipt,
      identity: { ...receipt.identity, bridgeId: 'other' }
    })
  ).toThrow('identity_mismatch')
  expect(parseOrcadLiveCoveredCancellationReceipt({ ...receipt, authority: 'current' })).toEqual(
    receipt
  )
})
