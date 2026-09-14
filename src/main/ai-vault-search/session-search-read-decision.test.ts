import { expect, it } from 'vitest'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import type { SessionSearchIndexedFile } from './session-search-file-cursor'
import {
  SESSION_SEARCH_FAILURES_BEFORE_HELD_OUT,
  sessionSearchReadDecision
} from './session-search-read-decision'
import type { SessionSearchFileRow } from './session-search-store'

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

it('reads a path the index holds nothing for, and lets the reader continue where it can', () => {
  // Not `whole`: there is no span this index has to reach past, and the first
  // enablement inside a running app has a warm list cursor to make use of.
  expect(decide({ row: undefined })).toBe('any')
})

it('skips a file the index already covers at this stat', () => {
  expect(decide({})).toBe('skip')
})

it('reads a file whose stat moved, however it moved', () => {
  expect(decide({ file: { mtimeMs: MTIME + 1 } })).toBe('any')
  // Grown without its mtime moving: a same-second append, or a restored stamp.
  expect(decide({ file: { sizeBytes: 200 } })).toBe('any')
})

it('reads a file outside the retention window not at all', () => {
  expect(decide({ row: undefined, cutoffMs: MTIME + 1 })).toBe('skip')
  // And retention wins over everything else that would have asked for a read.
  expect(decide({ row: row({ state: 'due' }), cutoffMs: MTIME + 1 })).toBe('skip')
})

it('reads a row owed a whole read from the start', () => {
  expect(decide({ row: row({ state: 'due' }) })).toBe('whole')
})

it('reads whole rather than appending onto a cursor that continues nothing', () => {
  // A different file at the same name: the identity check hands back no cursor.
  expect(decide({ cursor: null })).toBe('whole')
  // A chunked read that committed a prefix and no offset any append continues.
  expect(decide({ cursor: { byteOffset: null, mtimeMs: MTIME, sizeBytes: 100 } })).toBe('whole')
  // Shorter than the index read to, so this is not that file any more.
  expect(decide({ file: { sizeBytes: 40 }, cursor })).toBe('whole')
})

it('retries a failed read until it has failed enough times at one stat', () => {
  for (let failures = 1; failures < SESSION_SEARCH_FAILURES_BEFORE_HELD_OUT; failures++) {
    expect(
      decide({ row: row({ state: 'failed', failCount: failures, failedMtimeMs: MTIME }) })
    ).toBe('any')
  }
  expect(
    decide({
      row: row({
        state: 'failed',
        failCount: SESSION_SEARCH_FAILURES_BEFORE_HELD_OUT,
        failedMtimeMs: MTIME
      })
    })
  ).toBe('skip')
})

it('starts trying again the moment a held-out file changes', () => {
  // The stat is the whole release condition, so nothing has to remember when
  // the failures happened or schedule a retry.
  expect(
    decide({
      file: { mtimeMs: MTIME + 1 },
      row: row({ state: 'failed', failCount: 9, failedMtimeMs: MTIME })
    })
  ).toBe('any')
})
