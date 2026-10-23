import { appendFile, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import type SyncDatabase from '../sqlite/sync-database'
import { SessionSearchEngine } from './session-search-engine'
import { readIndexGeneration, readIndexIncarnation } from './session-search-index-generation'
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

/** Read through a separate connection so generation checks must observe other writers. */
function reader(path: string): SyncDatabase {
  const db = openSessionSearchDatabase(path)
  handles.push(db)
  new SessionSearchEngine(db)
  return db
}

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
  // Visibility changes when file/session rows disappear; later reclamation also changes vocabulary.
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
  // Orphan deletion changes typo vocabulary even though retrieval already excludes those messages.
  const root = await tempRoot()
  const path = join(root, 'index.sqlite')
  const db = reader(path)
  const store = new SessionSearchStore(path, (error) => {
    throw error
  })
  try {
    await indexOneTranscript(root, store)
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
  // Deleting messages attached to live sessions must not fire the orphan-reclamation trigger.
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
  const root = await tempRoot()
  const path = join(root, 'index.sqlite')
  reader(path)
  const first = new SessionSearchStore(path, (error) => {
    throw error
  })
  await indexOneTranscript(root, first)
  const firstReader = reader(path)
  const indexed = readIndexGeneration(firstReader)
  const incarnation = readIndexIncarnation(firstReader)
  first.close()

  const second = new SessionSearchStore(path)
  try {
    expect(readIndexGeneration(reader(path))).toBe(indexed)
    expect(readIndexIncarnation(reader(path))).toBe(incarnation)
  } finally {
    second.close()
  }
})

it('fences a reader against a writer it does not share a process with', async () => {
  // A process-local generation would miss another process’s writes and admit stale cursors.
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
  const root = await tempRoot()
  const path = join(root, 'index.sqlite')
  const db = reader(path)
  const store = new SessionSearchStore(path, (error) => {
    throw error
  })
  try {
    const transcript = await indexOneTranscript(root, store)
    const engine = new SessionSearchEngine(db)
    db.exec('DROP TRIGGER search_generation_file_update')
    engine.search({ query: 'needle' })

    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?")
        .get('search_generation_file_update')
    ).toEqual({ name: 'search_generation_file_update' })

    // Update only the restored trigger’s table so other trigger types cannot mask a missing repair.
    const restored = readIndexGeneration(db)
    db.exec(`UPDATE files SET mtime_ms = mtime_ms + 1 WHERE path = '${transcript}'`)
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
    expect(new Set(seen).size).toBe(seen.length)
    expect([...seen].sort((left, right) => left - right)).toEqual(seen)
  } finally {
    second.close()
    first.close()
  }
})
