import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  openSessionSearchIndexerHarness,
  type SessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'
import { SessionSearchStore } from './session-search-store'

// This answers "has the index ever held anything under this directory", and the
// degraded-root fence turns it into "do not delete this tree". A sibling whose
// name merely starts with the root's would arm the fence for the wrong root.

let harness: SessionSearchIndexerHarness
let store: SessionSearchStore

beforeEach(async () => {
  harness = await openSessionSearchIndexerHarness('ss-held-files')
  mkdirSync(dirname(harness.databasePath), { recursive: true })
  store = new SessionSearchStore(harness.databasePath)
})

afterEach(async () => {
  store.close()
  await harness.cleanup()
})

function hold(path: string): void {
  harness.write((db) =>
    db.prepare('INSERT INTO files(path,byte_offset,mtime_ms) VALUES (?,0,0)').run(path)
  )
}

it('matches a held file at a path segment boundary, not a bare prefix', () => {
  hold(join('/a', 'agents-old', 'x', 'one.jsonl'))

  expect(store.hasIndexedFilesUnder('/a/agents-old')).toBe(true)
  // The sibling root must not inherit its neighbour's evidence.
  expect(store.hasIndexedFilesUnder('/a/agents')).toBe(false)
  expect(store.hasIndexedFilesUnder('/a/agents-old/x')).toBe(true)
})

it('matches under either separator, and never on the root itself', () => {
  hold('C:\\Users\\me\\.openclaw\\agents\\s\\one.jsonl')
  expect(store.hasIndexedFilesUnder('C:\\Users\\me\\.openclaw\\agents')).toBe(true)
  expect(store.hasIndexedFilesUnder('C:\\Users\\me\\.openclaw\\agent')).toBe(false)

  hold('/only/a/file')
  expect(store.hasIndexedFilesUnder('/only/a/file')).toBe(false)
})
