import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { appliedCoverageFixture } from './orcad-live-applied-coverage-test-fixture'
import { liveSourceCompletionEvidenceFixture } from './orcad-live-source-completion-evidence-test-fixture'
import { createOrcadLiveCompletedCutover } from './orcad-live-completed-cutover'
import { validateOrcadLiveCompletedRecovery } from './orcad-live-completed-recovery'
import { readOrcadLiveSourceCompletionEvidence } from './orcad-live-source-completion-evidence'
import { parseOrcadLiveSourceCompletionEvidence } from '../../shared/orcad-live-source-completion-evidence'
import {
  createOrcadLiveSuccessorCompletionPreparation,
  createOrcadLiveSuccessorRouteCheckpoint,
  OrcadLiveSuccessorCompletionPreparationStore,
  OrcadLiveSuccessorRouteCheckpointStore,
  readOrcadLiveSuccessorCompletionEvidence
} from './orcad-live-successor-completion-records'
import {
  createOrcadLiveAppliedCoverageEvidence,
  OrcadLiveAppliedCoverageEvidenceStore
} from './orcad-live-applied-coverage-evidence'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-successor-completed-recovery-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})
const retiredAt = '2026-09-07T12:00:00.000Z'

function persistSuccessor(
  record: Parameters<typeof createOrcadLiveSuccessorCompletionPreparation>[1]
) {
  const preparation = createOrcadLiveSuccessorCompletionPreparation(root, record)
  new OrcadLiveSuccessorCompletionPreparationStore(root).persist(preparation)
  new OrcadLiveSuccessorRouteCheckpointStore(root).persist(
    createOrcadLiveSuccessorRouteCheckpoint(preparation)
  )
  return readOrcadLiveSuccessorCompletionEvidence(root, record)
}

function fixture() {
  const f = appliedCoverageFixture(root)
  f.evidenceStore.persist(f.create())
  const evidence = persistSuccessor(f.record)
  const completed = createOrcadLiveCompletedCutover({
    committed: f.record.release.cutover,
    completionEvidence: evidence,
    retiredAt
  })
  return { ...f, evidence, completed }
}

it('validates a successor-completed journal against its full real mixed-cancellation dependency chain', () => {
  const f = fixture()
  expect(f.completed.sourceCompletion.version).toBe(2)
  expect(validateOrcadLiveCompletedRecovery(root, f.completed)).toEqual({
    record: f.record,
    completed: f.completed
  })
  expect(() => parseOrcadLiveSourceCompletionEvidence(f.evidence)).toThrow()
})

it.each([
  'orcad-live-successor-completion-preparations',
  'orcad-live-successor-route-checkpoints',
  'orcad-live-applied-coverage-evidence',
  'orcad-live-source-cancellation-receipts',
  'orcad-outgoing-captures',
  'orcad-live-source-retirement-records'
])('refuses missing successor dependency %s', (directory) => {
  const f = fixture()
  f.remove(directory)
  expect(() => validateOrcadLiveCompletedRecovery(root, f.completed)).toThrow()
})

it.each(['retirementRecordSha256', 'sourceRouteCheckpointSha256'] as const)(
  'refuses wrong successor journal digest %s',
  (field) => {
    const f = fixture()
    const changed = { ...f.completed, sourceCompletion: { ...f.evidence, [field]: 'f'.repeat(64) } }
    expect(() => validateOrcadLiveCompletedRecovery(root, changed)).toThrow()
  }
)

it.each([0, 1, 3, '2', null])('refuses successor evidence relabeled with version %s', (version) => {
  const f = fixture()
  expect(() =>
    validateOrcadLiveCompletedRecovery(root, {
      ...f.completed,
      sourceCompletion: { ...f.evidence, version }
    })
  ).toThrow()
})

function bothChains() {
  const f = liveSourceCompletionEvidenceFixture(root, 'folder')
  f.persist()
  new OrcadLiveAppliedCoverageEvidenceStore(root).persist(
    createOrcadLiveAppliedCoverageEvidence({
      profileDirectory: root,
      record: f.record,
      coverages: []
    })
  )
  const v2 = persistSuccessor(f.record)
  const v1 = readOrcadLiveSourceCompletionEvidence(root, f.committed)
  const candidate = (completionEvidence: unknown) =>
    createOrcadLiveCompletedCutover({ committed: f.committed, completionEvidence, retiredAt })
  return { ...f, v1, v2, candidate }
}

it('dispatches exactly by version when both fully valid historical chains exist', () => {
  const f = bothChains()
  for (const evidence of [f.v1, f.v2]) {
    const completed = f.candidate(evidence)
    expect(validateOrcadLiveCompletedRecovery(root, completed)).toEqual({
      record: f.record,
      completed
    })
  }
  expect(() =>
    validateOrcadLiveCompletedRecovery(root, f.candidate({ ...f.v1, version: 2 }))
  ).toThrow()
  expect(() =>
    validateOrcadLiveCompletedRecovery(root, f.candidate({ ...f.v2, version: 1 }))
  ).toThrow()
})

it.each([1, 2] as const)(
  'never substitutes the other complete chain when version %s evidence is missing',
  (version) => {
    const f = bothChains()
    const completed = f.candidate(version === 1 ? f.v1 : f.v2)
    const missing =
      version === 1
        ? 'orcad-live-source-route-checkpoints'
        : 'orcad-live-successor-route-checkpoints'
    rmSync(join(root, missing), { recursive: true })
    expect(() => validateOrcadLiveCompletedRecovery(root, completed)).toThrow()
    const other = f.candidate(version === 1 ? f.v2 : f.v1)
    expect(validateOrcadLiveCompletedRecovery(root, other)).toEqual({
      record: f.record,
      completed: other
    })
  }
)
