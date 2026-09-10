import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { parserPublishesMessages } from '../ai-vault/session-scanner-agent-parser'
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

// The invariants this file exists to pin are written at the top of
// session-search-deleted-sources.ts. Each one is named in the tests below.

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

/** A reader that answers with whatever a stalled mount would, per directory. */
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
    limit?: number
  } = {}
) {
  return retireDeletedSessionSearchSources({
    store,
    paths,
    roots: options.roots ?? [harness.roots.claudeProjectsDir ?? ''],
    emptiedRoots: options.emptiedRoots,
    enumeratedContainers: options.enumeratedContainers,
    listings: options.listings ?? new SessionSearchDirectoryListings(),
    limit: options.limit
  })
}

// I4: a file the user deleted retires on the first pass that proves it, with no
// waiting period, because its directory listed and it was not in the listing.
it('retires a deleted file the moment its own directory lists without it', async () => {
  const kept = join(harness.claudeProjectDir, 'kept.jsonl')
  await mkdir(harness.claudeProjectDir, { recursive: true })
  await writeFile(kept, '{}')
  const deleted = join(harness.claudeProjectDir, 'deleted.jsonl')

  const result = await retire([kept, deleted])
  expect(result.retired).toEqual([deleted])
  expect(removed).toEqual([deleted])
  // A file that is still there is settled, not watched: it is neither retired
  // nor carried into the next pass as unfinished business.
  expect(result.unverifiable).toEqual([])
  expect(result.degradedRoots).toEqual([])
})

// I4, the other shape: the directory itself is gone, so the question moves up
// one level and the root answers it.
it('retires a whole project directory the user deleted', async () => {
  const sibling = join(harness.roots.claudeProjectsDir ?? '', 'other', 'kept.jsonl')
  await mkdir(join(harness.roots.claudeProjectsDir ?? '', 'other'), { recursive: true })
  await writeFile(sibling, '{}')
  const gone = join(harness.claudeProjectDir, 'inside-a-deleted-project.jsonl')

  const result = await retire([gone])
  expect(result.retired).toEqual([gone])
  expect(result.unverifiable).toEqual([])
})

// I1 and I2: a root that is not there proves nothing. The walk stops at the
// configured root and never asks what is above it, so a home directory on an
// unmounted volume — the shape a detached drive or a dropped SSH mount takes —
// leaves every row exactly where it was.
it('keeps every row under a root that is not there', async () => {
  const root = harness.roots.claudeProjectsDir ?? ''
  const held = [join(harness.claudeProjectDir, 'one.jsonl'), join(root, 'flat.jsonl')]

  const result = await retire(held)
  expect(result.retired).toEqual([])
  expect(result.unverifiable).toEqual(held)
  // The root is named, once, so a caller can say which tree is unreachable.
  expect(result.degradedRoots).toEqual([{ root, reason: `${root} could not be listed.` }])
})

// I3: the same answer with no memory at all. Nothing here is carried from a
// previous pass, which is what makes the first sweep after a restart — when a
// volume is most likely to be missing — behave like every other pass.
it('keeps a missing root on a pass that has seen nothing before it', async () => {
  const root = harness.roots.claudeProjectsDir ?? ''
  const held = join(harness.claudeProjectDir, 'one.jsonl')
  const first = await retire([held], { emptiedRoots: new Set() })
  const second = await retire([held], { emptiedRoots: new Set() })
  expect([first.retired, second.retired]).toEqual([[], []])
  expect(second.degradedRoots.map((one) => one.root)).toEqual([root])
})

// I2: an unreadable directory is not an empty one. EACCES stops the walk where
// it is rather than being walked up like a missing component.
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

// I2, without needing a filesystem that can produce it: a stalled network mount
// answers EIO or a WSL gate refusal, and neither is ENOENT. This is the SSH and
// WSL case — loss of contact is never evidence of absence.
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

// The one bit of memory, and the only thing it buys: a root that held
// transcripts on the previous pass and lists empty on this one gets one pass of
// grace, so a directory swapped out for a moment cannot retire a tree.
it('holds a root that went from holding transcripts to empty in one pass', async () => {
  const root = harness.roots.claudeProjectsDir ?? ''
  await mkdir(root, { recursive: true })
  const held = join(harness.claudeProjectDir, 'one.jsonl')

  const grace = await retire([held], { emptiedRoots: new Set([root]) })
  expect(grace.retired).toEqual([])
  expect(grace.unverifiable).toEqual([held])

  // The next pass has no transition to point at, so the empty listing is what
  // it says it is: the user emptied the root.
  const after = await retire([held], { emptiedRoots: new Set() })
  expect(after.retired).toEqual([held])
})

// A flat-layout agent, where the mountpoint IS the session directory, is the
// one shape the grace exists for: there is no intermediate directory whose
// absence could stop the walk.
it('holds a flat root that emptied in one pass, and retires it on the next', async () => {
  const root = harness.roots.copilotSessionsDir ?? ''
  await mkdir(root, { recursive: true })
  const held = join(root, 'session.jsonl')

  expect((await retire([held], { roots: [root], emptiedRoots: new Set([root]) })).retired).toEqual(
    []
  )
  expect((await retire([held], { roots: [root] })).retired).toEqual([held])
})

// OpenClaw's discovery merges two directories into one delimiter-joined label.
// Roots reach this function as the real directories behind that label, so one
// of them being unreachable never touches the other's rows.
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

// A row under no configured root is judged by its own directory and nothing
// above it, so a moved profile is never retired on the strength of a root that
// no longer covers it.
it('judges a row under no configured root by its own directory', async () => {
  const orphanDir = join(harness.root, 'moved-profile')
  await mkdir(orphanDir, { recursive: true })
  const gone = join(orphanDir, 'gone.jsonl')
  const present = join(orphanDir, 'present.jsonl')
  await writeFile(present, '{}')

  const result = await retire([gone, present], { roots: [] })
  expect(result.retired).toEqual([gone])
  // No configured root owns it, so nothing is reported as degraded for it.
  expect(result.degradedRoots).toEqual([])
})

// I8. A synthetic row names a container and an entry inside it. Walking the
// row's own path would report every one of them gone, and walking only the
// container proves nothing about the entry: a session deleted inside a database
// that is still there would never be retired at all.
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

  // A cycle asks for the newest N per agent, so a row it did not return may be
  // the one after them. It enumerates nothing and therefore proves nothing.
  await expect(retire([row], { roots: [] })).resolves.toMatchObject({
    retired: [],
    unverifiable: [row]
  })

  // An enumeration that returned nothing at all is not evidence either: a
  // database whose schema this scanner no longer recognises reads as empty
  // with no error, and believing it would retire every session in one pass.
  await expect(
    retire([row], { roots: [], enumeratedContainers: new Map([[db, new Set<string>()]]) })
  ).resolves.toMatchObject({ retired: [], unverifiable: [row] })
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

// Nothing in this PR can hold a synthetic row: the index pass refuses a source
// whose parser decodes its messages where the message channel cannot reach
// them, and OpenCode's SQLite sessions are read on a worker thread. The rule
// above is the guard for the day that changes -- without it the walk would read
// `<db>#<id>` as a filename and retire every such row the moment it appeared.
it('does not index a source whose messages the channel cannot reach', () => {
  const db = join(harness.root, 'opencode.db')
  expect(
    parserPublishesMessages({
      agent: 'opencode',
      codexHome: null,
      file: { path: `${db}#session-1`, mtimeMs: 1, modifiedAt: '', sizeBytes: 0 }
    })
  ).toBe(false)
})

it('caps the walks one pass spends and leaves the rest to be checked again', async () => {
  const paths = ['a', 'b', 'c', 'd'].map((name) => join(harness.claudeProjectDir, name))
  await mkdir(harness.claudeProjectDir, { recursive: true })
  const result = await retire(paths, { limit: 2 })
  expect(result.retired).toEqual(paths.slice(0, 2))
  expect(result.unchecked).toEqual(paths.slice(2))
})

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
