import { expect, it } from 'vitest'
import type { SessionFileCandidate } from '../../ai-vault/session-scanner-types'
import type { SessionSearchIndexedFile } from '../storage/session-search-file-cursor'
import { sessionSearchReadDecision } from './session-search-read-decision'
import type { SessionSearchFileRow } from '../storage/session-search-store-types'

const PATH = '/transcripts/one.jsonl'
const MTIME = 1_740_000_000_000

function candidate(overrides: Partial<SessionFileCandidate['file']> = {}): SessionFileCandidate {
  return {
    agent: 'claude',
    codexHome: null,
    file: {
      path: PATH,
      mtimeMs: MTIME,
      modifiedAt: new Date(MTIME).toISOString(),
      sizeBytes: 100,
      ...overrides
    }
  }
}

function row(overrides: Partial<SessionSearchFileRow> = {}): SessionSearchFileRow {
  return {
    path: PATH,
    identity: null,
    mtimeMs: MTIME,
    sizeBytes: 100,
    state: 'current',
    failCount: 0,
    failedMtimeMs: null,
    ...overrides
  }
}

const cursor: SessionSearchIndexedFile = { byteOffset: 100, mtimeMs: MTIME, sizeBytes: 100 }

function decide(args: {
  file?: Partial<SessionFileCandidate['file']>
  row?: SessionSearchFileRow | undefined
  cursor?: SessionSearchIndexedFile | null
  cutoffMs?: number | null
}) {
  return sessionSearchReadDecision({
    candidate: candidate(args.file),
    row: 'row' in args ? args.row : row(),
    cursor: 'cursor' in args ? (args.cursor ?? null) : cursor,
    cutoffMs: args.cutoffMs ?? null
  })
}

it('reads a file outside the retention window not at all', () => {
  expect(decide({ row: undefined, cutoffMs: MTIME + 1 })).toBe('skip')
  expect(decide({ row: row({ state: 'due' }), cutoffMs: MTIME + 1 })).toBe('skip')
})

it('reads whole rather than appending onto a cursor that continues nothing', () => {
  // A replaced file fails the cursor’s identity check.
  expect(decide({ cursor: null })).toBe('whole')
  // A committed prefix has no resumable offset.
  expect(decide({ cursor: { byteOffset: null, mtimeMs: MTIME, sizeBytes: 100 } })).toBe('whole')
  expect(decide({ file: { sizeBytes: 40 }, cursor })).toBe('whole')
})

it('starts trying again the moment a held-out file changes', () => {
  expect(
    decide({
      file: { mtimeMs: MTIME + 1 },
      row: row({ state: 'failed', failCount: 9, failedMtimeMs: MTIME })
    })
  ).toBe('any')
})
