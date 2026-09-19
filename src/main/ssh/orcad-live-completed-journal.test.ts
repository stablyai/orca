import { expect, it } from 'vitest'
import { liveSourceRetirementFixture } from '../persistence/migrating-orcad-catalog/orcad-live-source-retirement-test-fixture'
import {
  parseOrcadMigrationSourceCutover,
  normalizeOrcadMigrationSourceCutovers,
  compactOrcadMigrationSourceCutoversForAdmission
} from '../../shared/orcad-migration-source-cutover'
import { validateOrcadLiveCutoverTransition } from '../../shared/orcad-live-cutover-transition'

const sourceCompletion = {
  version: 1,
  retirementRecordSha256: 'a'.repeat(64),
  sourceRouteCheckpointSha256: 'b'.repeat(64)
}
const retiredAt = '2026-09-07T12:00:00.000Z'

function fixture(kind: 'folder' | 'worktree' = 'folder') {
  const committed = liveSourceRetirementFixture(kind).cutover
  const completed = {
    ...committed,
    phase: 'source-retired',
    updatedAt: retiredAt,
    retiredAt,
    sourceCompletion
  }
  return { committed, completed }
}

it.each(['folder', 'worktree'] as const)(
  'roundtrips completed %s v2 journals through normalization',
  (kind) => {
    const { completed } = fixture(kind)
    expect(parseOrcadMigrationSourceCutover(completed)).toEqual(completed)
    expect(normalizeOrcadMigrationSourceCutovers(JSON.parse(JSON.stringify([completed])))).toEqual([
      completed
    ])
  }
)

it.each([
  undefined,
  null,
  {},
  { ...sourceCompletion, version: 3 },
  { ...sourceCompletion, retirementRecordSha256: 'invalid' },
  { ...sourceCompletion, sourceRouteCheckpointSha256: 'B'.repeat(64) }
])('refuses missing or malformed source completion evidence %j', (evidence) => {
  const { completed } = fixture()
  const changed = { ...completed, sourceCompletion: evidence }
  expect(() => parseOrcadMigrationSourceCutover(changed)).toThrow()
  expect(normalizeOrcadMigrationSourceCutovers([changed])).toEqual([])
})

it.each(['folder', 'worktree'] as const)(
  'preserves explicit successor completion evidence for %s journals',
  (kind) => {
    const { completed } = fixture(kind)
    const successor = {
      ...completed,
      sourceCompletion: { ...sourceCompletion, version: 2 }
    }
    expect(parseOrcadMigrationSourceCutover(successor)).toEqual(successor)
    expect(normalizeOrcadMigrationSourceCutovers(JSON.parse(JSON.stringify([successor])))).toEqual([
      successor
    ])
  }
)

it.each(['absent', 'partial', 'duplicate', 'foreign'] as const)(
  'requires complete exact publications: %s',
  (mode) => {
    const { completed } = fixture()
    const publications = structuredClone(completed.terminalPublications!)
    if (mode === 'partial') {
      publications.pop()
    }
    if (mode === 'duplicate') {
      publications[1] = publications[0]
    }
    if (mode === 'foreign') {
      publications[0].catalog.migrationId = 'foreign'
    }
    expect(() =>
      parseOrcadMigrationSourceCutover({
        ...completed,
        terminalPublications: mode === 'absent' ? undefined : publications
      })
    ).toThrow()
  }
)

it.each(['retiredAt', 'updatedAt'] as const)('rejects malformed or mismatched %s', (field) => {
  const { completed } = fixture()
  for (const value of [undefined, '', 'invalid', '2026-09-08T12:00:00.000Z']) {
    expect(() => parseOrcadMigrationSourceCutover({ ...completed, [field]: value })).toThrow()
  }
})

it.each(['source-fenced', 'destination-staged', 'destination-committed'] as const)(
  'refuses completion evidence on v2 %s',
  (phase) => {
    const { committed } = fixture()
    expect(() =>
      parseOrcadMigrationSourceCutover({
        ...committed,
        phase,
        stagedAt: committed.updatedAt,
        sourceCompletion
      })
    ).toThrow()
  }
)

it.each([
  'source-fenced',
  'destination-staged',
  'destination-committed',
  'source-retired'
] as const)('preserves v1 %s behavior without accepting v2 completion evidence', (phase) => {
  const { committed } = fixture()
  const legacy = {
    ...committed,
    version: 1,
    liveTerminalBindings: undefined,
    terminalPublications: undefined,
    phase,
    stagedAt: committed.updatedAt,
    retiredAt
  }
  expect(parseOrcadMigrationSourceCutover(legacy)).toMatchObject({ version: 1, phase })
  expect(() => parseOrcadMigrationSourceCutover({ ...legacy, sourceCompletion })).toThrow()
})

it('never turns malformed completion evidence into a completed journal during normalization', () => {
  const { committed, completed } = fixture()
  const malformed = { ...completed, sourceCompletion: undefined }
  expect(normalizeOrcadMigrationSourceCutovers([committed, malformed])).toEqual([committed])
})

it('retains completed v2 journals at admission capacity', () => {
  const { completed } = fixture()
  const parsed = parseOrcadMigrationSourceCutover(completed)
  const journals = Array.from({ length: 4 }, () => parsed)
  expect(compactOrcadMigrationSourceCutoversForAdmission(journals)).toEqual(journals)
})

it('does not expose final completion through the generic live progress transition', () => {
  const { committed, completed } = fixture()
  expect(() => validateOrcadLiveCutoverTransition(committed, completed)).toThrow()
  expect(() => validateOrcadLiveCutoverTransition(completed, committed)).toThrow()
  expect(() => validateOrcadLiveCutoverTransition(completed, completed)).toThrow()
  expect(() =>
    validateOrcadLiveCutoverTransition(
      {
        ...committed,
        phase: 'source-fenced',
        terminalPublications: undefined
      },
      completed
    )
  ).toThrow()
  expect(validateOrcadLiveCutoverTransition(committed, committed)).toEqual(committed)
})
