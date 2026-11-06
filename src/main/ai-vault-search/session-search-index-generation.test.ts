import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import type SyncDatabase from '../sqlite/sync-database'
import { SessionSearchEngine } from './session-search-engine'
import { readIndexGeneration } from './session-search-index-generation'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import { resetSessionParseCacheForTests } from '../ai-vault/parse-cache/session-parse-cache-store'
import { resetTranscriptConsumersForTests } from '../ai-vault/transcripts/session-transcript-consumers'
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

it('fences a reader against another database handle moving the index', async () => {
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
