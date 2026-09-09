import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import { retireDeletedSessionSearchSources } from './session-search-deleted-sources'
import {
  openSessionSearchIndexerHarness,
  type SessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'
import { SessionSearchStore } from './session-search-store'

const CAN_DENY_READ = process.platform !== 'win32' && process.getuid?.() !== 0

let harness: SessionSearchIndexerHarness
let store: SessionSearchStore
let removed: string[]

beforeEach(async () => {
  resetTranscriptConsumersForTests()
  harness = await openSessionSearchIndexerHarness('ss-deleted-sources')
  removed = []
  store = new SessionSearchStore(harness.databasePath)
  // Only the removal matters here; the store's own removal path has its own tests.
  store.removeFile = (path: string) => removed.push(path)
})

afterEach(async () => {
  store.close()
  await harness.cleanup()
})

it('retires only what is proven gone and re-watches what it could not stat', async () => {
  const present = join(harness.root, 'present.jsonl')
  await writeFile(present, '{}')
  const result = await retireDeletedSessionSearchSources(store, [
    present,
    join(harness.root, 'never-existed.jsonl')
  ])
  expect(result.retired).toEqual([join(harness.root, 'never-existed.jsonl')])
  expect(removed).toEqual([join(harness.root, 'never-existed.jsonl')])
  expect(result.unverifiable).toEqual([])
})

it.skipIf(!CAN_DENY_READ)(
  'keeps rows for an unreadable source rather than calling it deleted',
  async () => {
    const blocked = join(harness.root, 'blocked')
    await mkdir(blocked)
    const hidden = join(blocked, 'hidden.jsonl')
    await writeFile(hidden, '{}')
    await chmod(blocked, 0o000)
    try {
      const result = await retireDeletedSessionSearchSources(store, [hidden])
      expect(result.retired).toEqual([])
      expect(result.unverifiable).toEqual([hidden])
      expect(removed).toEqual([])
    } finally {
      await chmod(blocked, 0o755)
    }
  }
)

it('stats the database behind a synthetic OpenCode row, not the row itself', async () => {
  const db = join(harness.root, 'opencode.db')
  await writeFile(db, '')
  const alive = `${db}#session-1`
  await expect(retireDeletedSessionSearchSources(store, [alive])).resolves.toMatchObject({
    retired: []
  })

  await rm(db)
  await expect(retireDeletedSessionSearchSources(store, [alive])).resolves.toMatchObject({
    retired: [alive]
  })
})

it('caps the stats one cycle spends and leaves the rest to be checked again', async () => {
  const paths = ['/a', '/b', '/c', '/d'].map((name) => join(harness.root, name))
  const result = await retireDeletedSessionSearchSources(store, paths, { limit: 2 })
  expect(result.retired).toEqual(paths.slice(0, 2))
  expect(result.unchecked).toEqual(paths.slice(2))
})
