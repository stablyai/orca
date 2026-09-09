import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import { SessionSearchEngine } from './session-search-engine'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import type { SessionSearchCursorError } from './session-search-page-cursor'
import { SessionSearchStore } from './session-search-store'
import { parseTranscript, userRecord } from './session-search-transcript-fixtures'

let roots: string[] = []

afterEach(async () => {
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
  await Promise.all(roots.map((root) => removeTree(root)))
  roots = []
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-search-generation-'))
  roots.push(root)
  return root
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

it('moves the generation forward when a published read changes what a read returns', async () => {
  const root = await tempRoot()
  const store = new SessionSearchStore(join(root, 'index.sqlite'), (error) => {
    throw error
  })
  try {
    const before = store.generation
    await indexOneTranscript(root, store)
    expect(store.generation).toBeGreaterThan(before)
  } finally {
    store.close()
  }
})

it('moves the generation forward when a proven deletion hides a session', async () => {
  const root = await tempRoot()
  const store = new SessionSearchStore(join(root, 'index.sqlite'), (error) => {
    throw error
  })
  try {
    const path = await indexOneTranscript(root, store)
    const indexed = store.generation
    store.removeFile(path)
    expect(store.generation).toBeGreaterThan(indexed)
  } finally {
    store.close()
  }
})

it('leaves the generation alone when a removal hides nothing', async () => {
  // A backfill retires paths it never held; if that moved the generation, every
  // cursor would be refused for as long as indexing ran.
  const root = await tempRoot()
  const store = new SessionSearchStore(join(root, 'index.sqlite'), (error) => {
    throw error
  })
  try {
    await indexOneTranscript(root, store)
    const before = store.generation
    store.removeFile('/synthetic/never-indexed.jsonl')
    expect(store.generation).toBe(before)
  } finally {
    store.close()
  }
})

it('keeps the generation across a reopen, because the bump rides its own commit', async () => {
  // The bump is inside the transaction that changes visibility, so nothing can
  // be lost to a crash and reopening need not invalidate anyone's cursor.
  const root = await tempRoot()
  const path = join(root, 'index.sqlite')
  const first = new SessionSearchStore(path, (error) => {
    throw error
  })
  await indexOneTranscript(root, first)
  const indexed = first.generation
  first.close()

  const second = new SessionSearchStore(path)
  try {
    expect(second.generation).toBe(indexed)
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
  const writer = new SessionSearchStore(path, (error) => {
    throw error
  })
  const reader = new SessionSearchStore(path)
  try {
    const transcripts: string[] = []
    for (let n = 0; n < 3; n++) {
      transcripts.push(await indexOneTranscript(root, writer))
    }
    const engine = new SessionSearchEngine(reader)
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
    reader.close()
    writer.close()
  }
})

it('mints a distinct generation per change even when two handles write', async () => {
  const root = await tempRoot()
  const path = join(root, 'index.sqlite')
  const first = new SessionSearchStore(path, (error) => {
    throw error
  })
  const second = new SessionSearchStore(path, (error) => {
    throw error
  })
  try {
    const seen: number[] = [first.generation]
    for (const store of [first, second, first, second]) {
      await indexOneTranscript(root, store)
      seen.push(store.generation)
    }
    // Read-then-write from two connections would hand out one value twice.
    expect(new Set(seen).size).toBe(seen.length)
    expect([...seen].sort((left, right) => left - right)).toEqual(seen)
    expect(first.generation).toBe(second.generation)
  } finally {
    second.close()
    first.close()
  }
})
