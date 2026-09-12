import { expect, it } from 'vitest'
import {
  parseOrcadMigrationSourceCutover,
  normalizeOrcadMigrationSourceCutovers
} from '../../../shared/orcad-migration-source-cutover'
import { terminalLayoutAdmissionFixture } from './orcad-terminal-layout-admission-test-fixture'
import { receipt } from '../../orcad-migration-source-cutover-test-fixture'
import { validateOrcadLiveCutoverTransition } from '../../../shared/orcad-live-cutover-transition'

function fixture() {
  const { manifest, bindings } = terminalLayoutAdmissionFixture('folder')
  return {
    version: 2,
    phase: 'destination-committed',
    destinationEnvironmentId: 'environment',
    manifest,
    liveTerminalBindings: bindings,
    receipt: receipt(manifest),
    startedAt: manifest.createdAt,
    updatedAt: manifest.createdAt,
    terminalPublications: bindings.map(({ identity, surfaceBinding }, index) => ({
      identity,
      catalog: { migrationId: manifest.migrationId, manifestSha256: manifest.manifestSha256 },
      publicationReceipt: {
        version: 1,
        bridgeId: identity.bridgeId,
        destinationRuntimeId: identity.destinationRuntimeId,
        publicationReceiptId: `publication-${index}`,
        publishedAt: manifest.createdAt,
        surfaceBinding,
        commitReceipt: {
          receiptId: `commit-${index}`,
          bridgeId: identity.bridgeId,
          acceptedSourceEndSeq: 10,
          committedAt: manifest.createdAt
        }
      }
    }))
  }
}

it('retains complete exact terminal receipts with the committed catalog through normalization', () => {
  const record = fixture()
  expect(parseOrcadMigrationSourceCutover(record)).toEqual(record)
  expect(normalizeOrcadMigrationSourceCutovers(JSON.parse(JSON.stringify([record])))).toEqual([
    record
  ])
})

it('retains partial publication progress before catalog commit without allowing completion', () => {
  const record = fixture()
  record.terminalPublications.pop()
  expect(() => parseOrcadMigrationSourceCutover(record)).toThrow('completion_evidence_required')
  expect(
    parseOrcadMigrationSourceCutover({
      ...record,
      phase: 'destination-staged',
      stagedAt: record.startedAt
    })
  ).toMatchObject({ terminalPublications: record.terminalPublications })
})

it.each([
  'missing',
  'duplicate',
  'lease',
  'runtime',
  'pane',
  'catalog',
  'commit-bridge',
  'receipt-id',
  'legacy'
] as const)('rejects %s publication evidence', (change) => {
  const record = structuredClone(fixture())
  const first = record.terminalPublications[0]
  if (change === 'missing') {
    Reflect.deleteProperty(record, 'terminalPublications')
  } else if (change === 'duplicate') {
    record.terminalPublications[1] = first
  } else if (change === 'lease') {
    Object.assign(first.identity, { ownerLease: 'other' })
    // Keep the intended authority unchanged: structuredClone preserves aliases.
    record.liveTerminalBindings = fixture().liveTerminalBindings
  } else if (change === 'runtime') {
    first.publicationReceipt.destinationRuntimeId = 'other'
  } else if (change === 'pane') {
    Object.assign(first.publicationReceipt, {
      surfaceBinding: { ...first.publicationReceipt.surfaceBinding, tabId: 'other' }
    })
  } else if (change === 'catalog') {
    first.catalog.manifestSha256 = '0'.repeat(64)
  } else if (change === 'commit-bridge') {
    first.publicationReceipt.commitReceipt.bridgeId = 'other'
  } else if (change === 'receipt-id') {
    record.terminalPublications[1].publicationReceipt.publicationReceiptId =
      first.publicationReceipt.publicationReceiptId
  } else {
    record.version = 1
  }
  expect(() => parseOrcadMigrationSourceCutover(record)).toThrow()
})

it('does not treat complete destination publication as proof of source retirement', () => {
  expect(() => parseOrcadMigrationSourceCutover({ ...fixture(), phase: 'source-retired' })).toThrow(
    'completion_evidence_required'
  )
})

it('allows monotonic partial publication then complete catalog commit and exact retry', () => {
  const committed = fixture()
  const initial = { ...committed, phase: 'source-fenced', terminalPublications: undefined }
  const partial = {
    ...committed,
    phase: 'destination-staged',
    stagedAt: committed.startedAt,
    terminalPublications: committed.terminalPublications.slice(0, 1)
  }
  expect(validateOrcadLiveCutoverTransition(initial, partial)).toMatchObject({
    terminalPublications: partial.terminalPublications
  })
  expect(validateOrcadLiveCutoverTransition(partial, committed)).toEqual(committed)
  expect(validateOrcadLiveCutoverTransition(committed, committed)).toEqual(committed)
})

it.each(['phase', 'receipt', 'publication', 'drop', 'authority', 'time'] as const)(
  'rejects %s regression in live progress',
  (change) => {
    const current = fixture()
    const next = structuredClone(current)
    if (change === 'phase') {
      next.phase = 'source-fenced'
    } else if (change === 'receipt') {
      next.receipt.importedAt = '2026-09-07T00:00:00.000Z'
    } else if (change === 'publication') {
      next.terminalPublications[0].publicationReceipt.publicationReceiptId = 'other'
    } else if (change === 'drop') {
      next.terminalPublications.pop()
    } else if (change === 'authority') {
      next.destinationEnvironmentId = 'other'
    } else {
      next.updatedAt = '2020-01-01T00:00:00.000Z'
    }
    expect(() => validateOrcadLiveCutoverTransition(current, next)).toThrow()
  }
)
