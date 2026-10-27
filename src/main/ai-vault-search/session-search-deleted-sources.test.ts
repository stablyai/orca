import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import { retireDeletedSessionSearchSources } from './session-search-deleted-sources'
import {
  SessionSearchDirectoryListings,
  type SessionSearchDirectoryListing,
  type SessionSearchDirectoryReader
} from './session-search-directory-listings'
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
  store.removeFile = (path: string) => removed.push(path)
})

afterEach(async () => {
  store.close()
  await harness.cleanup()
})

function readerAnswering(
  answers: Record<string, SessionSearchDirectoryListing>
): SessionSearchDirectoryReader {
  return {
    namesIn: (directory) =>
      Promise.resolve(
        answers[directory] ?? { listed: false, code: 'ENOENT', message: 'no such directory' }
      )
  }
}

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

it('retires a deleted file the moment its own directory lists without it', async () => {
  const kept = join(harness.claudeProjectDir, 'kept.jsonl')
  await mkdir(harness.claudeProjectDir, { recursive: true })
  await writeFile(kept, '{}')
  const deleted = join(harness.claudeProjectDir, 'deleted.jsonl')

  const result = await retire([kept, deleted])
  expect(result.retired).toEqual([deleted])
  expect(removed).toEqual([deleted])
  expect(result.unverifiable).toEqual([])
  expect(result.degradedRoots).toEqual([])
})

it('retires a whole project directory the user deleted', async () => {
  const sibling = join(harness.roots.claudeProjectsDir ?? '', 'other', 'kept.jsonl')
  await mkdir(join(harness.roots.claudeProjectsDir ?? '', 'other'), { recursive: true })
  await writeFile(sibling, '{}')
  const gone = join(harness.claudeProjectDir, 'inside-a-deleted-project.jsonl')

  const result = await retire([gone])
  expect(result.retired).toEqual([gone])
  expect(result.unverifiable).toEqual([])
})

it('keeps every row under a root that is not there', async () => {
  const root = harness.roots.claudeProjectsDir ?? ''
  const held = [join(harness.claudeProjectDir, 'one.jsonl'), join(root, 'flat.jsonl')]

  const result = await retire(held)
  expect(result.retired).toEqual([])
  expect(result.unverifiable).toEqual(held)
  expect(result.degradedRoots).toEqual([{ root, reason: `${root} could not be listed.` }])
})

it('keeps a missing root on a pass that has seen nothing before it', async () => {
  const root = harness.roots.claudeProjectsDir ?? ''
  const held = join(harness.claudeProjectDir, 'one.jsonl')
  const first = await retire([held], { emptiedRoots: new Set() })
  const second = await retire([held], { emptiedRoots: new Set() })
  expect([first.retired, second.retired]).toEqual([[], []])
  expect(second.degradedRoots.map((one) => one.root)).toEqual([root])
})

it.skipIf(!CAN_DENY_READ)('keeps rows under a directory that refuses to list', async () => {
  const blocked = join(harness.roots.claudeProjectsDir ?? '', 'blocked')
  await mkdir(blocked, { recursive: true })
  const hidden = join(blocked, 'hidden.jsonl')
  await writeFile(hidden, '{}')
  await chmod(blocked, 0o000)
  try {
    const result = await retire([hidden])
    expect(result.retired).toEqual([])
    expect(result.unverifiable).toEqual([hidden])
    expect(result.degradedRoots.map((one) => one.root)).toEqual([harness.roots.claudeProjectsDir])
  } finally {
    await chmod(blocked, 0o755)
  }
})

it('keeps rows when a directory answers with a transport failure', async () => {
  const root = harness.roots.claudeProjectsDir ?? ''
  const held = join(harness.claudeProjectDir, 'one.jsonl')
  for (const listing of [
    { listed: false as const, code: 'EIO', message: 'input/output error' },
    { listed: false as const, code: 'ETIMEDOUT', message: 'the mount stopped answering' },
    { listed: false as const, code: null, message: 'The distro stopped responding.' }
  ]) {
    const result = await retire([held], {
      listings: readerAnswering({ [harness.claudeProjectDir]: listing })
    })
    expect(result.retired).toEqual([])
    expect(result.degradedRoots).toEqual([{ root, reason: listing.message }])
  }
})

it('holds a root that went from holding transcripts to empty in one pass', async () => {
  const root = harness.roots.claudeProjectsDir ?? ''
  await mkdir(root, { recursive: true })
  const held = join(harness.claudeProjectDir, 'one.jsonl')

  const grace = await retire([held], { emptiedRoots: new Set([root]) })
  expect(grace.retired).toEqual([])
  expect(grace.unverifiable).toEqual([held])

  const after = await retire([held], { emptiedRoots: new Set() })
  expect(after.retired).toEqual([held])
})

it('holds a flat root that emptied in one pass, and retires it on the next', async () => {
  const root = harness.roots.copilotSessionsDir ?? ''
  await mkdir(root, { recursive: true })
  const held = join(root, 'session.jsonl')

  expect((await retire([held], { roots: [root], emptiedRoots: new Set([root]) })).retired).toEqual(
    []
  )
  expect((await retire([held], { roots: [root] })).retired).toEqual([held])
})

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

it('judges a row under no configured root by its own directory', async () => {
  const orphanDir = join(harness.root, 'moved-profile')
  await mkdir(orphanDir, { recursive: true })
  const gone = join(orphanDir, 'gone.jsonl')
  const present = join(orphanDir, 'present.jsonl')
  await writeFile(present, '{}')

  const result = await retire([gone, present], { roots: [] })
  expect(result.retired).toEqual([gone])
  expect(result.degradedRoots).toEqual([])
})

it('proves a synthetic row against its container, not against its own path', async () => {
  const db = join(harness.root, 'opencode.db')
  await writeFile(db, '')
  const kept = `${db}#session-1`
  const deleted = `${db}#session-2`
  const enumeratedContainers = new Map([[db, new Set(['session-1'])]])

  const result = await retire([kept, deleted], { roots: [], enumeratedContainers })
  expect(result.retired).toEqual([deleted])
  expect(result.unverifiable).toEqual([])
})

it('keeps a synthetic row when this pass did not enumerate its container', async () => {
  const db = join(harness.root, 'opencode.db')
  await writeFile(db, '')
  const row = `${db}#session-1`

  // A recency-capped scan cannot prove an unreturned database row was deleted.
  await expect(retire([row], { roots: [] })).resolves.toMatchObject({
    retired: [],
    unverifiable: [row]
  })

  // An unrecognized schema can enumerate empty, so an empty census cannot justify retirement.
  await expect(
    retire([row], { roots: [], enumeratedContainers: new Map([[db, new Set<string>()]]) })
  ).resolves.toMatchObject({ retired: [], unverifiable: [row] })
})

it('keeps a ZCode SQLite row when its database read failed during discovery', async () => {
  const db = join(harness.root, 'db.sqlite')
  await writeFile(db, '')
  const row = `${db}#zcode-session`

  const result = await retire([row], { roots: [] })
  expect(result.retired).toEqual([])
  expect(result.unverifiable).toEqual([row])
  expect(removed).toEqual([])
})

it('retires a ZCode SQLite row only after a successful full database enumeration', async () => {
  const db = join(harness.root, 'db.sqlite')
  await writeFile(db, '')
  const kept = `${db}#session-1`
  const deleted = `${db}#session-2`

  const result = await retire([kept, deleted], {
    roots: [],
    enumeratedContainers: new Map([[db, new Set(['session-1'])]])
  })
  expect(result.retired).toEqual([deleted])
  expect(result.unverifiable).toEqual([])
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

it('caps the directories one pass reads, not the rows it answers', async () => {
  const roots = [harness.claudeProjectDir]
  const inside = (folder: string, name: string): string =>
    join(harness.claudeProjectDir, folder, name)
  for (const folder of ['one', 'two', 'three']) {
    await mkdir(join(harness.claudeProjectDir, folder), { recursive: true })
  }
  const paths = ['one', 'two', 'three'].flatMap((folder) =>
    ['a', 'b', 'c', 'd'].map((name) => inside(folder, name))
  )

  const result = await retire(paths, { roots, directoryLimit: 2 })

  expect(result.retired).toEqual(paths.slice(0, 8))
  expect(result.unchecked).toEqual(paths.slice(8))
})

it.skipIf(!CAN_DENY_READ)(
  'is not starved by many rows under one unreadable directory',
  async () => {
    const locked = join(harness.claudeProjectDir, 'locked')
    await mkdir(locked, { recursive: true })
    const blocked = Array.from({ length: 520 }, (_unused, index) =>
      join(locked, `locked-${index}.jsonl`)
    )
    const deleted = join(harness.claudeProjectDir, 'deleted.jsonl')
    await chmod(locked, 0o000)
    try {
      const result = await retire([...blocked, deleted], { directoryLimit: 512 })

      expect(result.retired).toEqual([deleted])
      expect(result.unverifiable).toHaveLength(blocked.length)
      expect(result.unchecked).toEqual([])
    } finally {
      await chmod(locked, 0o700)
    }
  }
)

it('reads each directory once however many files it is asked about', async () => {
  await mkdir(harness.claudeProjectDir, { recursive: true })
  const listings = new SessionSearchDirectoryListings()
  await retire(
    Array.from({ length: 50 }, (_unused, index) =>
      join(harness.claudeProjectDir, `gone-${index}.jsonl`)
    ),
    { listings }
  )
  expect(listings.size).toBe(1)
})
