import { appendFile, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import type SyncDatabase from '../sqlite/sync-database'
import { SessionSearchEngine } from './session-search-engine'
import { readIndexGeneration } from './session-search-index-generation'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import type { SessionSearchCursorError } from './session-search-page-cursor'
import { openSessionSearchDatabase } from './session-search-schema'
import { SessionSearchStore } from './session-search-store'
import { parseTranscript, userRecord } from './session-search-transcript-fixtures'

let roots: string[] = []
let handles: SyncDatabase[] = []

afterEach(async () => {
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
  for (const handle of handles) {
    handle.close()
  }
  handles = []
  await Promise.all(roots.map((root) => removeTree(root)))
  roots = []
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-search-generation-'))
  roots.push(root)
  return root
}

/**
 * A reader's own handle on the index, with the engine's schema installed.
 *
 * PR 2's store keeps its connection private, so a reader opens its own — which
 * is what the fence has to survive: nothing this handle does moves the
 * generation, and it must still see every writer's move.
 */
function reader(path: string): SyncDatabase {
  const db = openSessionSearchDatabase(path)
  handles.push(db)
  // Constructing an engine is what installs the triggers.
  new SessionSearchEngine(db)
  return db
}

/** Indexes one transcript through the real consumer and returns its path. */
async function indexOneTranscript(root: string, store: SessionSearchStore): Promise<string> {
  resetSessionParseCacheForTests()
  const sessionId = `aaaaaaaa-0000-4000-8000-${String(roots.length).padStart(12, '0')}`
  const path = join(root, `${Math.random().toString(36).slice(2)}.jsonl`)
  await writeFile(path, `${userRecord(0, 'generation fixture needle', sessionId)}\n`)
  const unregister = registerSessionSearchIndexConsumer(store)
  try {
    await parseTranscript(path)
  } finally {
    unregister()
  }
  return path
}

it('moves the generation forward when a committed read changes what a read returns', async () => {
  const root = await tempRoot()
  const path = join(root, 'index.sqlite')
  const db = reader(path)
  const store = new SessionSearchStore(path, (error) => {
    throw error
  })
  try {
    const before = readIndexGeneration(db)
    await indexOneTranscript(root, store)
    expect(readIndexGeneration(db)).toBeGreaterThan(before)
  } finally {
    store.close()
  }
})

it('moves the generation forward when an append adds rows to a live session', async () => {
  // The first read of a file inserts its `files` row; every read after that
  // updates it. An append changes a session's rank and its message count, so a
  // cursor minted before it indexes into a list that no longer exists.
  const root = await tempRoot()
  const path = join(root, 'index.sqlite')
  const db = reader(path)
  const store = new SessionSearchStore(path, (error) => {
    throw error
  })
  try {
    const transcript = await indexOneTranscript(root, store)
    const indexed = readIndexGeneration(db)
    const unregister = registerSessionSearchIndexConsumer(store)
    try {
      resetSessionParseCacheForTests()
      await appendFile(transcript, `${userRecord(1, 'a second needle turn')}\n`)
      await parseTranscript(transcript)
    } finally {
      unregister()
    }
    expect(db.prepare('SELECT COUNT(*) AS c FROM messages').get()).toEqual({ c: 2 })
    expect(readIndexGeneration(db)).toBeGreaterThan(indexed)
  } finally {
    store.close()
  }
})

it('moves the generation forward when a proven deletion hides a session', async () => {
  const root = await tempRoot()
  const path = join(root, 'index.sqlite')
  const db = reader(path)
  const store = new SessionSearchStore(path, (error) => {
    throw error
  })
  try {
    const transcript = await indexOneTranscript(root, store)
    const indexed = readIndexGeneration(db)
    store.removeFile(transcript)
    expect(readIndexGeneration(db)).toBeGreaterThan(indexed)
  } finally {
    store.close()
  }
})

it('moves the generation forward when retention cuts a session loose', async () => {
  // Retention deletes the session row and the file row in one transaction, then
  // reclaims the messages over many. It is the first half that changes what a
  // search returns, and the first half that has to move the generation.
  const root = await tempRoot()
  const path = join(root, 'index.sqlite')
  const db = reader(path)
  const store = new SessionSearchStore(path, (error) => {
    throw error
  })
  try {
    await indexOneTranscript(root, store)
    const indexed = readIndexGeneration(db)
    await store.purgeOlderThan(Date.now() + 60_000)
    expect(db.prepare('SELECT COUNT(*) AS c FROM sessions').get()).toEqual({ c: 0 })
    expect(readIndexGeneration(db)).toBeGreaterThan(indexed)
  } finally {
    store.close()
  }
})

it('moves the generation when a purge reclaims rows nothing can reach', async () => {
  // The drain writes only `messages`, and for a while that was argued to change
  // no answer. Retrieval never saw those rows; the typo repair's dictionary
  // did, because `messages_vocab` is a view over the FTS b-tree and lists a
  // term whether or not a reader can reach it. See
  // `session-search-orphan-rows.test.ts` for the answer that moved. The price
  // of fencing it is a cursor refused once per batch while a purge runs.
  const root = await tempRoot()
  const path = join(root, 'index.sqlite')
  const db = reader(path)
  const store = new SessionSearchStore(path, (error) => {
    throw error
  })
  try {
    await indexOneTranscript(root, store)
    // The shape an interrupted purge leaves: rows with no session row.
    db.prepare('DELETE FROM sessions').run()
    const orphaned = readIndexGeneration(db)
    expect(db.prepare('SELECT COUNT(*) AS c FROM messages').get()).not.toEqual({ c: 0 })
    await store.purgeOlderThan(null)
    expect(db.prepare('SELECT COUNT(*) AS c FROM messages').get()).toEqual({ c: 0 })
    expect(readIndexGeneration(db)).toBeGreaterThan(orphaned)
  } finally {
    store.close()
  }
})

it("leaves the generation alone when a replace swaps a session's own rows", async () => {
  // The same trigger must not fire here, or every re-read of a large transcript
  // would move the generation once per deleted row on top of the one bump its
  // file record already makes. A replace deletes rows whose session row still
  // stands, which is what the trigger's `WHEN` clause tests.
  const root = await tempRoot()
  const path = join(root, 'index.sqlite')
  const db = reader(path)
  const store = new SessionSearchStore(path, (error) => {
    throw error
  })
  try {
    await indexOneTranscript(root, store)
    const rows = db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }
    const indexed = readIndexGeneration(db)
    db.prepare('DELETE FROM messages WHERE session_row_id IN (SELECT id FROM sessions)').run()
    expect(rows.c).toBeGreaterThan(0)
    expect(readIndexGeneration(db)).toBe(indexed)
  } finally {
    store.close()
  }
})

it('leaves the generation alone when a removal hides nothing', async () => {
  // A backfill retires paths it never held; if that moved the generation, every
  // cursor would be refused for as long as indexing ran.
  const root = await tempRoot()
  const path = join(root, 'index.sqlite')
  const db = reader(path)
  const store = new SessionSearchStore(path, (error) => {
    throw error
  })
  try {
    await indexOneTranscript(root, store)
    const before = readIndexGeneration(db)
    store.removeFile('/synthetic/never-indexed.jsonl')
    expect(readIndexGeneration(db)).toBe(before)
  } finally {
    store.close()
  }
})

it('keeps the generation across a reopen, because the bump rides its own commit', async () => {
  // The bump is inside the transaction that changes visibility, so nothing can
  // be lost to a crash and reopening need not invalidate anyone's cursor.
  const root = await tempRoot()
  const path = join(root, 'index.sqlite')
  reader(path)
  const first = new SessionSearchStore(path, (error) => {
    throw error
  })
  await indexOneTranscript(root, first)
  const indexed = readIndexGeneration(reader(path))
  first.close()

  const second = new SessionSearchStore(path)
  try {
    expect(readIndexGeneration(reader(path))).toBe(indexed)
  } finally {
    second.close()
  }
})

it('fences a reader against a writer it does not share a process with', async () => {
  // The shape PR 3 creates: the indexer writes from the scanner child while an
  // engine reads elsewhere. A generation cached in the reader's memory tracks
  // only that reader's own writes, so it would stand still through the
  // writer's deletion, honour the stale cursor, and skip a session.
  const root = await tempRoot()
  const path = join(root, 'index.sqlite')
  const db = reader(path)
  const writer = new SessionSearchStore(path, (error) => {
    throw error
  })
  try {
    const transcripts: string[] = []
    for (let n = 0; n < 3; n++) {
      transcripts.push(await indexOneTranscript(root, writer))
    }
    const engine = new SessionSearchEngine(db)
    const page = engine.search({ query: 'needle', limit: 1 })
    expect(page.page.cursor).not.toBeNull()

    writer.removeFile(transcripts[0]!)

    // The reader never wrote anything, and must still refuse.
    try {
      engine.search({ query: 'needle', limit: 1, cursor: page.page.cursor! })
      expect.unreachable('a page cursor must not survive another writer moving the index')
    } catch (error) {
      expect((error as SessionSearchCursorError).rejection).toBe('stale-generation')
    }
  } finally {
    writer.close()
  }
})

it('re-creates a fence something dropped, on the next search', async () => {
  // An index whose triggers are gone cannot move its generation, so every stale
  // cursor would compare equal and be honoured against a list the caller never
  // saw. The engine owns those triggers, so it puts them back.
  const root = await tempRoot()
  const path = join(root, 'index.sqlite')
  const db = reader(path)
  const store = new SessionSearchStore(path, (error) => {
    throw error
  })
  try {
    await indexOneTranscript(root, store)
    const engine = new SessionSearchEngine(db)
    db.exec('DROP TRIGGER search_generation_file_update')
    engine.search({ query: 'needle' })

    const restored = readIndexGeneration(db)
    await indexOneTranscript(root, store)
    expect(readIndexGeneration(db)).toBeGreaterThan(restored)
  } finally {
    store.close()
  }
})

it('mints a distinct generation per change even when two handles write', async () => {
  const root = await tempRoot()
  const path = join(root, 'index.sqlite')
  const db = reader(path)
  const first = new SessionSearchStore(path, (error) => {
    throw error
  })
  const second = new SessionSearchStore(path, (error) => {
    throw error
  })
  try {
    const seen: number[] = [readIndexGeneration(db)]
    for (const store of [first, second, first, second]) {
      await indexOneTranscript(root, store)
      seen.push(readIndexGeneration(db))
    }
    // Read-then-write from two connections would hand out one value twice.
    expect(new Set(seen).size).toBe(seen.length)
    expect([...seen].sort((left, right) => left - right)).toEqual(seen)
  } finally {
    second.close()
    first.close()
  }
})
