import { expect, it } from 'vitest'
import type { SessionFileCandidate } from '../../ai-vault/session-scanner-types'
import type { SessionSearchIndexedFile } from '../storage/session-search-file-cursor'
import {
  SESSION_SEARCH_FAILED_RETRY_BACKOFF_MS,
  SESSION_SEARCH_FAILURES_BEFORE_HELD_OUT,
  sessionSearchReadDecision
} from './session-search-read-decision'
import type { SessionSearchFileRow } from '../storage/session-search-store-types'

const PATH = '/transcripts/one.jsonl'
const MTIME = 1_740_000_000_000
const SIDECAR = { path: '/transcripts/events.jsonl', mtimeMs: MTIME, sizeBytes: 4096 }

function candidate(overrides: Partial<SessionFileCandidate['file']> = {}): SessionFileCandidate {
  return {
    agent: 'ante',
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
    sidecarMtimeMs: null,
    sidecarSizeBytes: null,
    state: 'current',
    failCount: 0,
    failedMtimeMs: null,
    failedSidecarMtimeMs: null,
    failedSidecarSizeBytes: null,
    failedAtMs: null,
    ...overrides
  }
}

const cursor: SessionSearchIndexedFile = { byteOffset: 100, mtimeMs: MTIME, sizeBytes: 100 }

function decide(
  file: Partial<SessionFileCandidate['file']>,
  indexed: SessionSearchFileRow,
  nowMs?: number
) {
  return sessionSearchReadDecision({
    candidate: candidate(file),
    row: indexed,
    cursor,
    cutoffMs: null,
    nowMs
  })
}

function heldOutRow(failedAtMs: number | null): SessionSearchFileRow {
  return row({
    state: 'failed',
    failCount: SESSION_SEARCH_FAILURES_BEFORE_HELD_OUT,
    sidecarMtimeMs: SIDECAR.mtimeMs,
    sidecarSizeBytes: SIDECAR.sizeBytes,
    failedMtimeMs: MTIME,
    failedSidecarMtimeMs: SIDECAR.mtimeMs,
    failedSidecarSizeBytes: SIDECAR.sizeBytes,
    failedAtMs
  })
}

/** A failure that never saw a sidecar stat, which is what a failed `unknown` read records. */
function unstampedSidecarRow(failedAtMs: number | null): SessionSearchFileRow {
  return row({
    state: 'failed',
    failCount: SESSION_SEARCH_FAILURES_BEFORE_HELD_OUT,
    failedMtimeMs: MTIME,
    failedAtMs
  })
}

it('skips a metadata-keyed session whose transcript sidecar is unchanged', () => {
  expect(
    decide(
      { sidecar: SIDECAR },
      row({ sidecarMtimeMs: SIDECAR.mtimeMs, sidecarSizeBytes: SIDECAR.sizeBytes })
    )
  ).toBe('skip')
})

it('rereads a metadata-keyed session when only its transcript sidecar changed', () => {
  // Ante writes meta.json at turn end, so the transcript runs ahead of the metadata stat.
  const indexed = row({ sidecarMtimeMs: SIDECAR.mtimeMs, sidecarSizeBytes: SIDECAR.sizeBytes })
  expect(decide({ sidecar: { ...SIDECAR, mtimeMs: MTIME + 1 } }, indexed)).toBe('any')
  expect(decide({ sidecar: { ...SIDECAR, sizeBytes: 9000 } }, indexed)).toBe('any')
})

it('rereads a metadata-keyed session whose sidecar stat was never persisted', () => {
  // Rows indexed before the stat column read back as null and must miss once.
  expect(decide({ sidecar: SIDECAR }, row())).toBe('any')
})

it('rereads when a stored sidecar disappears or cannot be statted', () => {
  const indexed = row({ sidecarMtimeMs: SIDECAR.mtimeMs, sidecarSizeBytes: SIDECAR.sizeBytes })
  expect(decide({ sidecar: 'none' }, indexed)).toBe('any')
  expect(decide({ sidecar: 'unknown' }, indexed)).toBe('any')
  expect(decide({ sidecar: undefined }, indexed)).toBe('any')
})

it('holds a failed file out while neither its own stat nor its sidecar moved', () => {
  expect(decide({ sidecar: SIDECAR }, heldOutRow(MTIME), MTIME + 1_000)).toBe('skip')
})

it('retries a held-out file after its transcript grew past an unchanged meta.json', () => {
  // The failure stamp is the whole point: a row whose sidecar grew since the failed read must be
  // reread even though Ante rewrote nothing in the metadata file this row keys on.
  expect(decide({ sidecar: { ...SIDECAR, sizeBytes: 9000 } }, heldOutRow(MTIME))).toBe('any')
})

it('holds a failed file whose sidecar is now unknown until its retry interval elapses', () => {
  // The failed read saw a sidecar, but an unstatable sidecar proves nothing changed either, so only
  // the backoff releases it; proving a change is left to the reread the backoff triggers.
  const failedAt = MTIME + 60_000
  expect(decide({ sidecar: 'unknown' }, heldOutRow(failedAt), failedAt + 1_000)).toBe('skip')
  expect(
    decide(
      { sidecar: 'unknown' },
      heldOutRow(failedAt),
      failedAt + SESSION_SEARCH_FAILED_RETRY_BACKOFF_MS
    )
  ).toBe('any')
})

it('holds a failed file whose sidecar was already unknown until its retry interval elapses', () => {
  const failedAt = MTIME + 60_000
  expect(decide({ sidecar: 'unknown' }, unstampedSidecarRow(failedAt), failedAt + 1_000)).toBe(
    'skip'
  )
  expect(
    decide(
      { sidecar: 'unknown' },
      unstampedSidecarRow(failedAt),
      failedAt + SESSION_SEARCH_FAILED_RETRY_BACKOFF_MS
    )
  ).toBe('any')
})

it('retries a held-out file whose sidecar stat was never stamped', () => {
  // Rows failed before the failure stamp existed cannot prove the sidecar is unchanged.
  const failed = row({
    state: 'failed',
    failCount: SESSION_SEARCH_FAILURES_BEFORE_HELD_OUT,
    sidecarMtimeMs: SIDECAR.mtimeMs,
    sidecarSizeBytes: SIDECAR.sizeBytes,
    failedMtimeMs: MTIME
  })
  expect(decide({ sidecar: SIDECAR }, failed)).toBe('any')
})

it('keeps a stat-frozen file held out until its retry interval elapses', () => {
  const failedAt = MTIME
  expect(decide({ sidecar: SIDECAR }, heldOutRow(failedAt), failedAt + 1_000)).toBe('skip')
  expect(
    decide(
      { sidecar: SIDECAR },
      heldOutRow(failedAt),
      failedAt + SESSION_SEARCH_FAILED_RETRY_BACKOFF_MS
    )
  ).toBe('any')
})

it('retries a file that failed before the retry clock was recorded', () => {
  // Rows written before failed_at_ms existed read back as null; the retry stamps the clock again.
  expect(decide({ sidecar: SIDECAR }, heldOutRow(null), MTIME + 10 * 60_000)).toBe('any')
})
