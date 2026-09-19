import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { appliedCoverageFixture } from './orcad-live-applied-coverage-test-fixture'
import { parseOrcadLiveSourceCompletionPreparation } from './orcad-live-source-completion-preparation'
import { parseOrcadLiveSourceRouteCheckpoint } from './orcad-live-source-route-checkpoint'
import { parseOrcadLiveSourceCompletionEvidence } from '../../shared/orcad-live-source-completion-evidence'
import {
  createOrcadLiveSuccessorCompletionPreparation,
  bindOrcadLiveSuccessorCompletionPreparation,
  OrcadLiveSuccessorCompletionPreparationStore,
  createOrcadLiveSuccessorRouteCheckpoint,
  bindOrcadLiveSuccessorRouteCheckpoint,
  OrcadLiveSuccessorRouteCheckpointStore,
  readOrcadLiveSuccessorCompletionEvidence
} from './orcad-live-successor-completion-records'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-successor-completion-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const f = appliedCoverageFixture(root)
  f.evidenceStore.persist(f.create())
  const prepStore = new OrcadLiveSuccessorCompletionPreparationStore(root)
  const routeStore = new OrcadLiveSuccessorRouteCheckpointStore(root)
  const preparation = createOrcadLiveSuccessorCompletionPreparation(root, f.record)
  const checkpoint = createOrcadLiveSuccessorRouteCheckpoint(preparation)
  const persist = () => {
    prepStore.persist(preparation)
    routeStore.persist(checkpoint)
  }
  return {
    ...f,
    prepStore,
    routeStore,
    preparation,
    checkpoint,
    persist,
    bind: () => bindOrcadLiveSuccessorRouteCheckpoint(root, f.record)
  }
}

it('joins the complete mixed receipt cohort without manufacturing ordinary settlements', () => {
  const f = fixture()
  f.persist()
  const bound = f.bind()
  expect(bound.preparation).toEqual(f.preparation)
  expect(bound.checkpoint).toEqual(f.checkpoint)
  expect(bound.preparation).toMatchObject({
    version: 2,
    phase: 'successor-completion-prepared',
    retirementRecordSha256: f.record.sha256
  })
  expect(bound.preparation).not.toHaveProperty('settlements')
  expect(() => bound.assertCurrent()).not.toThrow()
})

it('does not let candidate construction stand in for persisted evidence', () => {
  const f = fixture()
  expect(() => bindOrcadLiveSuccessorCompletionPreparation(root, f.record)).toThrow()
  f.prepStore.persist(f.preparation)
  expect(() => f.bind()).toThrow('route_checkpoint_changed')
  expect(() => readOrcadLiveSuccessorCompletionEvidence(root, f.record)).toThrow()
})

it.each([
  'appliedEvidenceSha256',
  'cancellationCohortSha256',
  'retirementRecordSha256',
  'migrationId'
] as const)('rejects a structurally valid but unrelated preparation %s', (field) => {
  const f = fixture()
  f.prepStore.persist({
    ...f.preparation,
    [field]: field === 'migrationId' ? 'other' : 'a'.repeat(64)
  })
  expect(() => bindOrcadLiveSuccessorCompletionPreparation(root, f.record)).toThrow(
    'preparation_changed'
  )
})

it('rejects a checkpoint referring to a different preparation', () => {
  const f = fixture()
  f.prepStore.persist(f.preparation)
  f.routeStore.persist({ ...f.checkpoint, completionPreparationSha256: 'a'.repeat(64) })
  expect(() => f.bind()).toThrow('route_checkpoint_changed')
})

it.each([
  'orcad-live-applied-coverage-evidence',
  'orcad-outgoing-captures',
  'orcad-live-source-cancellation-receipts',
  'orcad-live-source-retirement-records',
  'orcad-live-successor-completion-preparations',
  'orcad-live-successor-route-checkpoints'
])('refuses missing dependency %s after binding', (directory) => {
  const f = fixture()
  f.persist()
  const bound = f.bind()
  f.remove(directory)
  expect(() => bound.assertCurrent()).toThrow()
})

it('keeps ordinary v1 preparation and checkpoint parsers strict', () => {
  const f = fixture()
  expect(() => parseOrcadLiveSourceCompletionPreparation(f.preparation)).toThrow()
  expect(() => parseOrcadLiveSourceRouteCheckpoint(f.checkpoint)).toThrow()
  f.persist()
  const evidence = readOrcadLiveSuccessorCompletionEvidence(root, f.record)
  expect(evidence).toMatchObject({ version: 2, retirementRecordSha256: f.record.sha256 })
  expect(() => parseOrcadLiveSourceCompletionEvidence(evidence)).toThrow()
})

it('reflushes identical retries without changing retained record identity', () => {
  const f = fixture()
  f.persist()
  const first = f.bind()
  f.persist()
  expect(f.bind().checkpoint).toEqual(first.checkpoint)
  first.assertCurrent()
})
