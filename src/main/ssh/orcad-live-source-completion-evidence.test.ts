import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import {
  createOrcadLiveSourceCompletionEvidence,
  readOrcadLiveSourceCompletionEvidence
} from './orcad-live-source-completion-evidence'
import { liveSourceCompletionEvidenceFixture } from './orcad-live-source-completion-evidence-test-fixture'
import * as routes from './orcad-live-source-route-checkpoint'
import { OrcadLiveSourceCompletionPreparationStore } from './orcad-live-source-completion-preparation'
import { OrcadLiveSourceCancellationReceiptStore } from './orcad-live-source-cancellation-receipt'
import { OrcadLiveCleanupOutputEvidenceStore } from './orcad-live-cleanup-output-evidence'
import { OrcadLiveRuntimeCleanupCheckpointStore } from './orcad-live-runtime-cleanup-checkpoint'
import { OrcadLiveSourceRetirementRecordStore } from './orcad-live-source-retirement-record'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-source-completion-evidence-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

it.each(['folder', 'worktree'] as const)('hashes the exact validated %s checkpoint', (kind) => {
  const f = liveSourceCompletionEvidenceFixture(root, kind)
  f.persist()
  const before = structuredClone(f.committed)
  const result = readOrcadLiveSourceCompletionEvidence(root, f.committed)
  expect(result).toEqual({
    version: 1,
    retirementRecordSha256: f.record.sha256,
    sourceRouteCheckpointSha256: createHash('sha256')
      .update(serializeOrcadMigrationValue(f.checkpoint))
      .digest('hex')
  })
  expect(f.committed).toEqual(before)
  expect(
    readOrcadLiveSourceCompletionEvidence(
      root,
      Object.fromEntries(Object.entries(f.committed).toReversed())
    )
  ).toEqual(result)
})

it.each(['routes', 'preparation', 'receipts', 'output', 'runtime', 'record'] as const)(
  'requires the retained %s dependency',
  (missing) => {
    const f = liveSourceCompletionEvidenceFixture(root, 'folder')
    f.persist()
    if (missing === 'routes') {
      vi.spyOn(routes.OrcadLiveSourceRouteCheckpointStore.prototype, 'list').mockReturnValue([])
    }
    if (missing === 'preparation') {
      vi.spyOn(OrcadLiveSourceCompletionPreparationStore.prototype, 'list').mockReturnValue([])
    }
    if (missing === 'receipts') {
      vi.spyOn(OrcadLiveSourceCancellationReceiptStore.prototype, 'read').mockReturnValue(null)
    }
    if (missing === 'output') {
      vi.spyOn(OrcadLiveCleanupOutputEvidenceStore.prototype, 'list').mockReturnValue([])
    }
    if (missing === 'runtime') {
      vi.spyOn(OrcadLiveRuntimeCleanupCheckpointStore.prototype, 'list').mockReturnValue([])
    }
    if (missing === 'record') {
      vi.spyOn(OrcadLiveSourceRetirementRecordStore.prototype, 'list').mockReturnValue([])
    }
    expect(() => readOrcadLiveSourceCompletionEvidence(root, f.committed)).toThrow()
  }
)

it('refuses a route checkpoint whose preparation digest has changed', () => {
  const f = liveSourceCompletionEvidenceFixture(root, 'folder')
  f.persist()
  vi.spyOn(routes.OrcadLiveSourceRouteCheckpointStore.prototype, 'list').mockReturnValue([
    { ...f.checkpoint, completionPreparationSha256: 'b'.repeat(64) }
  ])
  expect(() => readOrcadLiveSourceCompletionEvidence(root, f.committed)).toThrow()
})

it.each(['updatedAt', 'destinationName', 'receipt', 'publication'] as const)(
  'rejects changed committed %s even when migration identity matches',
  (field) => {
    const f = liveSourceCompletionEvidenceFixture(root, 'folder')
    f.persist()
    const committed = structuredClone(f.committed)
    if (field === 'updatedAt') {
      committed.updatedAt = '2026-09-01T00:00:00.000Z'
    }
    if (field === 'destinationName') {
      committed.destinationName = 'replacement'
    }
    if (field === 'receipt') {
      committed.receipt = { ...committed.receipt, importedAt: '2026-09-01T00:00:00.000Z' }
    }
    if (field === 'publication') {
      const publication = committed.terminalPublications![0]
      committed.terminalPublications![0] = {
        ...publication,
        publicationReceipt: {
          ...publication.publicationReceipt,
          publicationReceiptId: 'replacement'
        }
      }
    }
    expect(() => readOrcadLiveSourceCompletionEvidence(root, committed)).toThrow()
  }
)

it('refuses duplicate matching validated records', () => {
  const f = liveSourceCompletionEvidenceFixture(root, 'folder')
  f.persist()
  const entry = { record: f.record, checkpoint: f.checkpoint }
  vi.spyOn(routes, 'listValidatedOrcadLiveSourceRouteCheckpoints').mockReturnValue([entry, entry])
  expect(() => readOrcadLiveSourceCompletionEvidence(root, f.committed)).toThrow()
})

it.each(['source-fenced', 'destination-staged', 'source-retired'] as const)(
  'refuses %s rather than a retained committed journal',
  (phase) => {
    const f = liveSourceCompletionEvidenceFixture(root, 'folder')
    expect(() =>
      readOrcadLiveSourceCompletionEvidence(root, {
        ...f.committed,
        phase,
        retiredAt: f.committed.updatedAt,
        stagedAt: f.committed.updatedAt
      })
    ).toThrow()
  }
)

it('refuses legacy catalog-only commitment', () => {
  const f = liveSourceCompletionEvidenceFixture(root, 'folder')
  expect(() =>
    readOrcadLiveSourceCompletionEvidence(root, {
      ...f.committed,
      version: 1,
      liveTerminalBindings: undefined,
      terminalPublications: undefined
    })
  ).toThrow()
})

it('rebuilds the same evidence from fully bound inputs without requiring filesystem discovery', () => {
  const f = liveSourceCompletionEvidenceFixture(root, 'folder')
  const evidence = createOrcadLiveSourceCompletionEvidence(f)
  f.persist()
  expect(evidence).toEqual(readOrcadLiveSourceCompletionEvidence(root, f.committed))
})

it.each(['cohort', 'settlement', 'checkpoint', 'committed'] as const)(
  'builder rejects structurally plausible but mismatched %s evidence',
  (field) => {
    const f = liveSourceCompletionEvidenceFixture(root, 'folder')
    const input = structuredClone({
      record: f.record,
      committed: f.committed,
      preparation: f.preparation,
      settlements: f.settlements,
      checkpoint: f.checkpoint
    })
    if (field === 'cohort') {
      input.preparation.receipts.pop()
      input.checkpoint = routes.createOrcadLiveSourceRouteCheckpoint(input.preparation)
    }
    if (field === 'settlement') {
      input.settlements[0].deliveryToken = 'other'
    }
    if (field === 'checkpoint') {
      input.checkpoint.completionPreparationSha256 = 'b'.repeat(64)
    }
    if (field === 'committed') {
      input.committed.destinationName = 'other'
    }
    expect(() => createOrcadLiveSourceCompletionEvidence(input)).toThrow()
  }
)
