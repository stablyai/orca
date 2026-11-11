import './session-search-worker.test-fixture'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetTranscriptConsumersForTests } from '../ai-vault/transcripts/session-transcript-consumers'
import { retireDeletedSessionSearchSources } from './session-search-deleted-sources'
import {
  SessionSearchDirectoryListings,
  type SessionSearchDirectoryReader
} from './session-search-directory-listings'
import {
  openSessionSearchIndexerHarness,
  type SessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'
import { SessionSearchStore } from './session-search-store'

let harness: SessionSearchIndexerHarness
let store: SessionSearchStore
let removed: string[]

beforeEach(async () => {
  resetTranscriptConsumersForTests()
  harness = await openSessionSearchIndexerHarness('ss-deleted-sources')
  removed = []
  store = new SessionSearchStore(harness.databasePath)
  store.removeFile = (path: string) => removed.push(path)
})

afterEach(async () => {
  store.close()
  await harness.cleanup()
})

function retire(
  paths: readonly string[],
  options: {
    roots?: readonly string[]
    emptiedRoots?: ReadonlySet<string>
    enumeratedContainers?: ReadonlyMap<string, ReadonlySet<string>>
    listings?: SessionSearchDirectoryReader
    directoryLimit?: number
  } = {}
) {
  return retireDeletedSessionSearchSources({
    store,
    paths,
    roots: options.roots ?? [harness.roots.claudeProjectsDir ?? ''],
    emptiedRoots: options.emptiedRoots,
    enumeratedContainers: options.enumeratedContainers,
    listings: options.listings ?? new SessionSearchDirectoryListings(),
    directoryLimit: options.directoryLimit
  })
}

it('judges each merged-root directory on its own', async () => {
  const current = join(harness.roots.openclawStateDir ?? '', 'agents')
  const legacy = join(harness.roots.openclawLegacyStateDir ?? '', 'agents')
  const onMissing = join(current, 'main', 'sessions', 'mounted.jsonl')
  const deleted = join(legacy, 'main', 'sessions', 'deleted.jsonl')
  await mkdir(join(legacy, 'main', 'sessions'), { recursive: true })

  const result = await retire([onMissing, deleted], { roots: [current, legacy] })
  expect(result.retired).toEqual([deleted])
  expect(result.unverifiable).toEqual([onMissing])
  expect(result.degradedRoots.map((one) => one.root)).toEqual([current])
})

it('retires a synthetic row when the container it came from is gone', async () => {
  const db = join(harness.root, 'opencode.db')
  await writeFile(db, '')
  const row = `${db}#session-1`
  const enumeratedContainers = new Map([[db, new Set(['session-1'])]])
  await expect(retire([row], { roots: [], enumeratedContainers })).resolves.toMatchObject({
    retired: []
  })

  await rm(db)
  await expect(retire([row], { roots: [], enumeratedContainers })).resolves.toMatchObject({
    retired: [row]
  })
})
