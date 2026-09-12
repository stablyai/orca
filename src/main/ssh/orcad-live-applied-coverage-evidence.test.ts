import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appliedCoverageFixture } from './orcad-live-applied-coverage-test-fixture'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-applied-coverage-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

it('records applied coverage for exactly the covered member of a complete mixed cancellation cohort', () => {
  const f = appliedCoverageFixture(root)
  const evidence = f.create()
  expect(evidence).toMatchObject({
    version: 1,
    phase: 'destination-output-applied',
    identity: f.record.identity,
    retirementRecordSha256: f.record.sha256,
    cancellationCohortSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    coverages: [f.coverage]
  })
  expect(evidence.coverages[0].coverage.throughSeq).toBe(
    f.retirement.coveredSourceDeliveryRetirement.sourceOutputEndSeq
  )
  f.evidenceStore.persist(evidence)
  expect(f.bind().evidence).toEqual(evidence)
  expect(() => f.bind().assertCurrent()).not.toThrow()
})

it.each(['missing', 'duplicate', 'extra', 'wrong-member'] as const)(
  'refuses %s coverage',
  (kind) => {
    const f = appliedCoverageFixture(root)
    const other = { ...f.coverage, identity: f.record.release.activations[1].identity }
    const supplied =
      kind === 'missing'
        ? []
        : kind === 'duplicate'
          ? [f.coverage, f.coverage]
          : kind === 'extra'
            ? [f.coverage, other]
            : [other]
    expect(() => f.create(supplied)).toThrow('cohort_incomplete')
  }
)

it.each(['boundary', 'ack', 'model', 'publication', 'claim'] as const)(
  'refuses wrong %s evidence',
  (kind) => {
    const f = appliedCoverageFixture(root)
    const value = structuredClone(f.coverage)
    if (kind === 'boundary') {
      value.coverage.throughSeq--
    }
    if (kind === 'ack') {
      value.coverage.acknowledgedEndSeq--
    }
    if (kind === 'model') {
      value.coverage.modelThroughSeq--
    }
    if (kind === 'publication') {
      value.publicationReceipt.publicationReceiptId = 'wrong'
    }
    if (kind === 'claim') {
      value.destinationClaim = { ...value.destinationClaim, claimId: 'wrong-at-same-generation' }
    }
    expect(() => f.create([value])).toThrow()
  }
)

it('accepts a newer destination claim without weakening the frozen source boundary', () => {
  const f = appliedCoverageFixture(root)
  const value = structuredClone(f.coverage)
  value.destinationClaim = { generation: 2, claimId: 'new-claim' }
  expect(f.create([value]).coverages[0].destinationClaim).toEqual(value.destinationClaim)
})

it.each([
  'orcad-live-source-cancellation-receipts',
  'orcad-outgoing-captures',
  'orcad-live-source-retirement-records'
])('rereads dependency %s after binding', (directory) => {
  const f = appliedCoverageFixture(root)
  f.evidenceStore.persist(f.create())
  const bound = f.bind()
  f.remove(directory)
  expect(() => bound.assertCurrent()).toThrow()
  expect(() => f.bind()).toThrow()
  expect(() => f.create()).toThrow()
})

it('also requires the ordinary member receipt in the mixed cancellation cohort', () => {
  const f = appliedCoverageFixture(root)
  f.evidenceStore.persist(f.create())
  const bound = f.bind()
  f.remove(
    'orcad-live-source-cancellation-receipts',
    f.record.release.activations[1].identity.bridgeId
  )
  expect(() => bound.assertCurrent()).toThrow()
})

it('rejects a hash-shaped but incorrect cancellation cohort reference', () => {
  const f = appliedCoverageFixture(root)
  f.evidenceStore.persist({ ...f.create(), cancellationCohortSha256: 'f'.repeat(64) })
  expect(() => f.bind()).toThrow('evidence_conflict')
})

it('refuses absent saved coverage evidence despite complete cancellation', () => {
  const f = appliedCoverageFixture(root)
  expect(() => f.bind()).toThrow('evidence_required')
})
