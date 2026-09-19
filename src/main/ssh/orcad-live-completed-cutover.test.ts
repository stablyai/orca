import { expect, it } from 'vitest'
import { liveSourceRetirementFixture } from '../persistence/migrating-orcad-catalog/orcad-live-source-retirement-test-fixture'
import { parseOrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import {
  createOrcadLiveCompletedCutover,
  assertOrcadLiveCompletedCutover
} from './orcad-live-completed-cutover'

const completionEvidence = {
  version: 1,
  retirementRecordSha256: 'a'.repeat(64),
  sourceRouteCheckpointSha256: 'b'.repeat(64)
}
const retiredAt = '2026-09-07T12:00:00.000Z'

function fixture(kind: 'folder' | 'worktree' = 'folder') {
  const committed = liveSourceRetirementFixture(kind).cutover
  const options = { committed, completionEvidence, retiredAt }
  const completed = createOrcadLiveCompletedCutover(options)
  return { ...options, completed }
}

it.each(['folder', 'worktree'] as const)(
  'builds and validates the exact %s successor without changing the committed journal',
  (kind) => {
    const committed = liveSourceRetirementFixture(kind).cutover
    const before = structuredClone(committed)
    const completed = createOrcadLiveCompletedCutover({ committed, completionEvidence, retiredAt })
    expect(completed).toEqual({
      ...committed,
      phase: 'source-retired',
      updatedAt: retiredAt,
      retiredAt,
      sourceCompletion: completionEvidence
    })
    expect(assertOrcadLiveCompletedCutover({ committed, completed, completionEvidence })).toEqual(
      completed
    )
    expect(committed).toEqual(before)
    expect(parseOrcadMigrationSourceCutover(completed)).toEqual(completed)
  }
)

it('validates repeated recovery against the retained timestamp without restamping', () => {
  const f = fixture()
  const before = structuredClone(f.completed)
  const first = assertOrcadLiveCompletedCutover(f)
  const retry = assertOrcadLiveCompletedCutover({ ...f, completed: first })
  expect(retry).toEqual(before)
  expect(retry.retiredAt).toBe(retiredAt)
})

it('accepts retirement exactly at the committed update boundary', () => {
  const f = fixture()
  expect(createOrcadLiveCompletedCutover({ ...f, retiredAt: f.committed.updatedAt })).toMatchObject(
    {
      updatedAt: f.committed.updatedAt,
      retiredAt: f.committed.updatedAt
    }
  )
})

it.each(['invalid', '', '1900-01-01T00:00:00.000Z'])(
  'refuses invalid or pre-commit retirement time %j',
  (timestamp) => {
    const f = fixture()
    expect(() => createOrcadLiveCompletedCutover({ ...f, retiredAt: timestamp })).toThrow()
    expect(() =>
      assertOrcadLiveCompletedCutover({
        ...f,
        completed: { ...f.completed, retiredAt: timestamp, updatedAt: timestamp }
      })
    ).toThrow()
  }
)

it.each(['retiredAt', 'updatedAt'] as const)('refuses alteration of only %s', (field) => {
  const f = fixture()
  expect(() =>
    assertOrcadLiveCompletedCutover({
      ...f,
      completed: { ...f.completed, [field]: '2026-09-08T12:00:00.000Z' }
    })
  ).toThrow()
})

it.each(['destinationEnvironmentId', 'destinationName', 'startedAt', 'version', 'phase'] as const)(
  'rejects changed preserved %s',
  (field) => {
    const f = fixture()
    const changed: Record<string, unknown> = { ...f.completed }
    changed[field] =
      field === 'version' ? 1 : field === 'startedAt' ? '2026-09-01T00:00:00.000Z' : 'replacement'
    expect(() => assertOrcadLiveCompletedCutover({ ...f, completed: changed })).toThrow()
  }
)

it.each(['manifest', 'receipt', 'liveTerminalBindings', 'terminalPublications'] as const)(
  'rejects changed preserved %s contents',
  (field) => {
    const f = fixture()
    const changed = structuredClone(f.completed)
    if (field === 'manifest') {
      changed.manifest = { ...changed.manifest, migrationId: 'foreign' }
    }
    if (field === 'receipt') {
      changed.receipt = { ...changed.receipt, importedAt: '2026-09-01T00:00:00.000Z' }
    }
    if (field === 'liveTerminalBindings') {
      changed.liveTerminalBindings = changed.liveTerminalBindings!.slice(1)
    }
    if (field === 'terminalPublications') {
      changed.terminalPublications = changed.terminalPublications!.slice(1)
    }
    expect(() => assertOrcadLiveCompletedCutover({ ...f, completed: changed })).toThrow()
  }
)

it.each(['retirementRecordSha256', 'sourceRouteCheckpointSha256'] as const)(
  'rejects an altered %s in either evidence input or completed journal',
  (field) => {
    const f = fixture()
    const changed = { ...completionEvidence, [field]: 'c'.repeat(64) }
    expect(() => assertOrcadLiveCompletedCutover({ ...f, completionEvidence: changed })).toThrow()
    expect(() =>
      assertOrcadLiveCompletedCutover({
        ...f,
        completed: { ...f.completed, sourceCompletion: changed }
      })
    ).toThrow()
  }
)

it('refuses malformed completion evidence during construction', () => {
  const f = fixture()
  expect(() =>
    createOrcadLiveCompletedCutover({
      ...f,
      completionEvidence: { ...completionEvidence, version: 2 }
    })
  ).toThrow()
})

it.each(['top-level', 'manifest', 'evidence'] as const)(
  'refuses unknown extra properties at %s',
  (location) => {
    const f = fixture()
    const completed =
      location === 'top-level'
        ? { ...f.completed, unexpected: true }
        : location === 'manifest'
          ? { ...f.completed, manifest: { ...f.completed.manifest, unexpected: true } }
          : { ...f.completed, sourceCompletion: { ...completionEvidence, unexpected: true } }
    expect(() => assertOrcadLiveCompletedCutover({ ...f, completed })).toThrow()
  }
)

it.each(['source-fenced', 'destination-staged', 'source-retired'] as const)(
  'requires committed input rather than %s',
  (phase) => {
    const f = fixture()
    const committed = { ...f.committed, phase, stagedAt: retiredAt, retiredAt }
    expect(() => createOrcadLiveCompletedCutover({ ...f, committed })).toThrow()
    expect(() => assertOrcadLiveCompletedCutover({ ...f, committed })).toThrow()
  }
)

it('rejects legacy committed input', () => {
  const f = fixture()
  const committed = {
    ...f.committed,
    version: 1,
    liveTerminalBindings: undefined,
    terminalPublications: undefined
  }
  expect(() => createOrcadLiveCompletedCutover({ ...f, committed })).toThrow()
  expect(() => assertOrcadLiveCompletedCutover({ ...f, committed })).toThrow()
})
