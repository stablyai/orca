import './session-search-worker.test-fixture'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
import { SessionSearchPassState } from './session-search-pass-state'
import type { SessionSearchPassArgs } from './session-search-pass'
import {
  retireSessionSearchPassSources,
  wakeSessionSearchPassRetirements
} from './session-search-pass-retirement'
import { syntheticCandidate, syntheticSession } from './session-search-index-test-fixture'

let harness: SessionSearchIndexerHarness
let store: SessionSearchStore
let removed: string[]

beforeEach(async () => {
  resetTranscriptConsumersForTests()
  harness = await openSessionSearchIndexerHarness('ss-deleted-sources')
  removed = []
  store = new SessionSearchStore(harness.databasePath)
  store.removeFile = (path: string) => {
    removed.push(path)
    return true
  }
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

function seedSearchableRows(population: number): string[] {
  const paths: string[] = []
  for (let index = 0; index < population; index++) {
    const path = join(harness.claudeProjectDir, `${String(index).padStart(4, '0')}.jsonl`)
    paths.push(path)
    const write = store.beginWrite(syntheticCandidate({ path }), 'replace', 0)!
    write.add({ role: 'user', text: 'retainedretirementneedle', timestamp: null })
    write.commit({
      session: syntheticSession({
        id: `retirement-${index}`,
        sessionId: `retirement-${index}`,
        filePath: path
      }),
      byteOffset: 100,
      incomplete: false
    })
  }
  return paths
}
function retirementArgs(state: SessionSearchPassState): SessionSearchPassArgs {
  return {
    store,
    state,
    roots: harness.roots,
    full: false,
    recentPerAgent: 12,
    listings: { namesIn: async () => ({ listed: true, names: new Set<string>() }) }
  }
}
function retainedRows(): number {
  return Number(
    store.connection
      .prepare(
        "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'retainedretirementneedle'"
      )
      .get()?.n ?? 0
  )
}

it('advances a long retirement sweep while one queued removal is refused', async () => {
  const paths = seedSearchableRows(600)
  const held = paths[0]
  store.removeFile = SessionSearchStore.prototype.removeFile.bind(store)
  const remove = store.removeFile.bind(store)
  let refusing = true
  vi.spyOn(store, 'removeFile').mockImplementation((path) => {
    if (path === held && refusing) {
      return false
    }
    return remove(path)
  })
  const state = new SessionSearchPassState()
  await state.prepare(store)
  await state.retire.set(held, held)
  try {
    const args = retirementArgs(state)
    await retireSessionSearchPassSources(args, [harness.roots.claudeProjectsDir!], new Set())
    expect(retainedRows()).toBe(1)
    refusing = false
    await retireSessionSearchPassSources(args, [harness.roots.claudeProjectsDir!], new Set())
    expect(retainedRows()).toBe(0)
    expect(state.pending).toBe(false)
  } finally {
    vi.restoreAllMocks()
    await state.close()
  }
})

it('continues a finite parked-retirement wake across passes without waking its new failures', async () => {
  const paths = seedSearchableRows(300)
  store.removeFile = SessionSearchStore.prototype.removeFile.bind(store)
  const state = new SessionSearchPassState()
  await state.prepare(store)
  state.needsRetirement = false
  await state.parkedRetire.setPage(paths.map((path) => [path, path] as const))
  const args = retirementArgs(state)
  const roots = [harness.roots.claudeProjectsDir!]
  const goodListings = args.listings
  try {
    // The first wake page is transferred; its removals refuse and return to parked state.
    await wakeSessionSearchPassRetirements({ ...args, full: true, discoveryOverdue: () => true })
    await retireSessionSearchPassSources(
      {
        ...args,
        listings: {
          namesIn: async () => ({
            listed: false,
            code: 'EIO',
            message: 'fixture inaccessible volume'
          })
        }
      },
      roots,
      new Set()
    )
    expect(retainedRows()).toBe(300)
    // An ordinary pass must carry the original wake through its remaining tail.
    await wakeSessionSearchPassRetirements(args)
    await retireSessionSearchPassSources({ ...args, listings: goodListings }, roots, new Set())
    expect(retainedRows()).toBe(256)
    expect(state.pending).toBe(false)
    await wakeSessionSearchPassRetirements(args)
    await retireSessionSearchPassSources(args, roots, new Set())
    expect(retainedRows()).toBe(256)
    // A new explicit wake can now retry the protected earlier page.
    await wakeSessionSearchPassRetirements({ ...args, full: true })
    await retireSessionSearchPassSources(args, roots, new Set())
    expect(retainedRows()).toBe(0)
    expect(state.pending).toBe(false)
  } finally {
    await state.close()
  }
})
