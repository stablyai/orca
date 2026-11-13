import { expect, it } from 'vitest'
import type { SessionFileCandidate } from '../../ai-vault/session-scanner-types'
import type { SessionSearchIndexedFile } from '../storage/session-search-file-cursor'
import { sessionSearchReadDecision } from './session-search-read-decision'
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
    ...overrides
  }
}

const cursor: SessionSearchIndexedFile = { byteOffset: 100, mtimeMs: MTIME, sizeBytes: 100 }

function decide(file: Partial<SessionFileCandidate['file']>, indexed: SessionSearchFileRow) {
  return sessionSearchReadDecision({
    candidate: candidate(file),
    row: indexed,
    cursor,
    cutoffMs: null
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
