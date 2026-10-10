import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import {
  decodeClaudeUsagePersistedFile,
  encodeClaudeUsagePersistedFiles,
  encodeClaudeUsagePersistedState
} from './persisted-token-columns'
import { buildClaudeUsageProjectionIntegrity } from './transcript-projection-integrity'
import { hasClaudeUsageResumeProjection } from './transcript-resume-projection'
import { aggregateClaudeUsage } from './usage-aggregation'
import type {
  ClaudeUsageAttributedTurn,
  ClaudeUsagePersistedFile,
  ClaudeUsagePersistedState,
  ClaudeUsageTokenMaxima
} from './types'

function fixture(rows: ClaudeUsageTokenMaxima[]): ClaudeUsagePersistedFile {
  const turns: ClaudeUsageAttributedTurn[] = []
  const routes = [0, 1].filter((index) => rows.some((row) => row[5] === index))
  const order = new Map<string, string[]>()
  for (const row of rows) {
    if (row[5] === null) {
      continue
    }
    const sessionId = `session-${row[5]}`
    const projectKey = `project-${row[5]}`
    order.set(sessionId, [projectKey])
    turns.push({
      sessionId,
      timestamp: '2026-10-09T12:00:00.000Z',
      model: 'model',
      cwd: null,
      gitBranch: null,
      inputTokens: row[0],
      outputTokens: row[1],
      cacheReadTokens: row[2],
      cacheWriteTokens: row[3],
      cacheWrite1hTokens: row[4],
      day: '2026-10-09',
      projectKey,
      projectLabel: projectKey,
      repoId: null,
      worktreeId: null
    })
  }
  const file: ClaudeUsagePersistedFile = {
    path: join(tmpdir(), 'claude-token-columns.jsonl'),
    mtimeMs: 1,
    size: 20_000,
    lineCount: rows.length + 1,
    physicalFileId: '1:2',
    ctimeMs: 2,
    ...aggregateClaudeUsage(turns),
    ownedDedupeKeys: rows.map((_, index) => `key-${index}`),
    hasDeferredClaims: true,
    parseResumeState: {
      parsedBytes: 20_000,
      lineCount: rows.length + 1,
      boundaryDigest: 'boundary',
      headDigest: 'head',
      physicalFileId: '1:2',
      ownedTokenMaxima: rows,
      projections: routes.map((index) => ({
        sessionId: `session-${index}`,
        day: '2026-10-09',
        model: 'model',
        projectKey: `project-${index}`
      })),
      encounterOrder: [...order].map(([sessionId, projectKeys]) => ({ sessionId, projectKeys }))
    }
  }
  if (!file.parseResumeState) {
    throw new Error('Expected a checkpoint fixture.')
  }
  file.parseResumeState.projectionIntegrity = buildClaudeUsageProjectionIntegrity(file)
  return file
}

function savedState(file: ClaudeUsagePersistedFile): ClaudeUsagePersistedState {
  return {
    schemaVersion: 7,
    worktreeFingerprint: '[]',
    processedFiles: [file],
    sessions: file.sessions,
    dailyAggregates: file.dailyAggregates,
    scanState: {
      enabled: true,
      lastScanStartedAt: 1,
      lastScanCompletedAt: 2,
      lastScanError: null
    }
  }
}

function pack(file: ClaudeUsagePersistedFile): ClaudeUsagePersistedFile {
  const state: ClaudeUsagePersistedState = JSON.parse(
    JSON.stringify(encodeClaudeUsagePersistedState(savedState(file)))
  )
  const packed = state.processedFiles[0]
  if (!packed) {
    throw new Error('Expected an encoded file.')
  }
  return packed
}

function columns(file: ClaudeUsagePersistedFile): unknown[] {
  const state = file.parseResumeState
  if (!state || !('ownedTokenColumns' in state) || !Array.isArray(state.ownedTokenColumns)) {
    throw new Error('Expected six encoded columns.')
  }
  return state.ownedTokenColumns
}

function decode(file: ClaudeUsagePersistedFile): {
  file: ClaudeUsagePersistedFile
  yields: number
} {
  const iterator = decodeClaudeUsagePersistedFile(file)
  let yields = 0
  let step = iterator.next()
  while (!step.done) {
    yields++
    step = iterator.next()
  }
  return { file: step.value, yields }
}

it('packs uniform columns without mutating tuples, sharing decoded rows or retaining disk fields', () => {
  const original = fixture([
    [100, 10, 0, 20, 5, 0],
    [100, 10, 0, 20, 5, 0]
  ])
  const before = structuredClone(original)
  const packed = pack(original)
  expect(columns(packed)).toEqual([100, 10, 0, 20, 5, 0])
  expect(packed.parseResumeState).toHaveProperty('tokenCodecVersion', 1)
  expect(packed.parseResumeState).not.toHaveProperty('ownedTokenMaxima')
  expect(original).toEqual(before)
  const decoded = decode(packed).file
  expect(decoded).toEqual(original)
  expect(decoded.parseResumeState).not.toHaveProperty('ownedTokenColumns')
  expect(decoded.parseResumeState).not.toHaveProperty('tokenCodecVersion')
  expect(hasClaudeUsageResumeProjection(decoded)).toBe(true)
  const first = decoded.parseResumeState?.ownedTokenMaxima[0]
  const second = decoded.parseResumeState?.ownedTokenMaxima[1]
  if (!first || !second) {
    throw new Error('Expected independent decoded rows.')
  }
  expect(first).not.toBe(second)
  first[0]++
  expect(second[0]).toBe(100)
  expect(original).toEqual(before)
})

it('preserves independently varying finite maxima, null routing and original integrity', () => {
  const original = fixture([
    [-1.5, 2.25, 0, 20, 5, 0],
    [3.75, 1, 4.5, 21, 6.25, 1],
    [Number.MAX_VALUE, -2.5, -3.25, 22, -1.5, null]
  ])
  const packed = pack(original)
  expect(columns(packed)).toEqual([
    [-1.5, 3.75, Number.MAX_VALUE],
    [2.25, 1, -2.5],
    [0, 4.5, -3.25],
    [20, 21, 22],
    [5, 6.25, -1.5],
    [0, 1, null]
  ])
  const decoded = decode(packed).file
  expect(decoded).toEqual(original)
  expect(buildClaudeUsageProjectionIntegrity(decoded)).toBe(
    original.parseResumeState?.projectionIntegrity
  )
  expect(hasClaudeUsageResumeProjection(decoded)).toBe(true)
})

it('uses empty scalars for zero owned keys and returns legacy and nonresumable files unchanged', () => {
  const empty = fixture([])
  expect(columns(pack(empty))).toEqual([0, 0, 0, 0, 0, null])
  expect(decode(pack(empty)).file).toEqual(empty)
  expect(decode(empty)).toEqual({ file: empty, yields: 0 })
  expect(decode(empty).file).toBe(empty)
  const small = { ...empty, parseResumeState: null }
  expect(decode(small).file).toBe(small)
  expect(pack(small)).toEqual(small)
})

it('yields every 1024 decoded rows before publishing a complete file', () => {
  const rows: ClaudeUsageTokenMaxima[] = Array.from({ length: 2050 }, (_, index) => [
    index,
    10,
    0,
    20,
    5,
    0
  ])
  const original = fixture(rows)
  const iterator = decodeClaudeUsagePersistedFile(pack(original))
  expect(iterator.next()).toEqual({ value: undefined, done: false })
  expect(iterator.next()).toEqual({ value: undefined, done: false })
  const completed = iterator.next()
  expect(completed.done).toBe(true)
  expect(completed.value).toEqual(original)
})

it('leaves a finite packed maximum drift visible to the coupled integrity validator', () => {
  const original = fixture([[100, 10, 0, 20, 5, 0]])
  const packed = pack(original)
  columns(packed)[0] = 99
  const decoded = decode(packed).file
  expect(decoded.parseResumeState?.ownedTokenMaxima[0]?.[0]).toBe(99)
  expect(decoded.parseResumeState?.projectionIntegrity).toBe(
    original.parseResumeState?.projectionIntegrity
  )
  expect(hasClaudeUsageResumeProjection(decoded)).toBe(false)
})

it('serializes a frozen source array and diagnostic state exactly like individual packing', () => {
  const first = fixture([[100, 10, 0, 20, 5, 0]])
  const second = fixture([
    [101, 11, 1, 21, 6, 0],
    [102, 12, 2, 22, 7, 0]
  ])
  const unsigned = structuredClone(first)
  if (!unsigned.parseResumeState) {
    throw new Error('Expected an unsigned checkpoint fixture.')
  }
  delete unsigned.parseResumeState.projectionIntegrity
  const state = savedState(first)
  state.processedFiles.push(second, unsigned, { ...first, parseResumeState: null })
  const before = structuredClone(state)
  const expected = { ...state, processedFiles: state.processedFiles.map(pack) }
  for (const file of state.processedFiles) {
    if (file.parseResumeState) {
      file.parseResumeState.ownedTokenMaxima.forEach(Object.freeze)
      Object.freeze(file.parseResumeState.ownedTokenMaxima)
      Object.freeze(file.parseResumeState)
    }
    Object.freeze(file.ownedDedupeKeys)
    Object.freeze(file)
  }
  Object.freeze(state.processedFiles)
  Object.freeze(state)
  expect(JSON.stringify(encodeClaudeUsagePersistedFiles(state.processedFiles))).toBe(
    JSON.stringify(expected.processedFiles)
  )
  expect(JSON.stringify(encodeClaudeUsagePersistedState(state))).toBe(JSON.stringify(expected))
  expect(pack(unsigned)).toEqual(unsigned)
  expect(state).toEqual(before)
})

it.each([
  { name: 'null column', index: 0, value: null },
  { name: 'string column', index: 1, value: '10' },
  { name: 'nonfinite scalar', index: 2, value: Number.POSITIVE_INFINITY },
  { name: 'short column', index: 0, value: [100] },
  { name: 'long column', index: 0, value: [100, 200, 300] },
  { name: 'nonnumeric value', index: 1, value: [10, '20'] },
  { name: 'null token value', index: 2, value: [0, null] },
  { name: 'nonfinite value', index: 3, value: [20, Number.NaN] },
  { name: 'negative route', index: 5, value: [0, -1] },
  { name: 'fractional route', index: 5, value: [0, 0.5] },
  { name: 'unknown route', index: 5, value: [0, 2] },
  { name: 'nonnumeric route', index: 5, value: [0, true] }
])('rejects $name before publishing decoded rows', ({ index, value }) => {
  const packed = pack(
    fixture([
      [100, 10, 0, 20, 5, 0],
      [200, 20, 1, 30, 6, 1]
    ])
  )
  columns(packed)[index] = value
  expect(() => decode(packed)).toThrow('Saved Claude usage token')
})

it.each([
  { tokenCodecVersion: undefined },
  { tokenCodecVersion: 0 },
  { tokenCodecVersion: 2 },
  { tokenCodecVersion: '1' },
  { ownedTokenColumns: undefined },
  { ownedTokenColumns: {} },
  { ownedTokenColumns: [1, 2, 3, 4, 5] },
  { ownedTokenColumns: [1, 2, 3, 4, 5, null, 7] },
  { ownedTokenMaxima: [[100, 10, 0, 20, 5, 0]] },
  { projectionIntegrity: undefined },
  { projectionIntegrity: null },
  { projectionIntegrity: 123 }
])('rejects unsupported, incomplete or duplicated codec fields %j', (patch) => {
  const packed = pack(fixture([[100, 10, 0, 20, 5, 0]]))
  if (!packed.parseResumeState) {
    throw new Error('Expected an encoded checkpoint.')
  }
  const corrupted: ClaudeUsagePersistedFile = JSON.parse(
    JSON.stringify({ ...packed, parseResumeState: { ...packed.parseResumeState, ...patch } })
  )
  expect(() => decode(corrupted)).toThrow('Saved Claude usage token')
})
