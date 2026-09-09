import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
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

async function indexOneTranscript(root: string, store: SessionSearchStore): Promise<void> {
  resetSessionParseCacheForTests()
  const sessionId = `aaaaaaaa-0000-4000-8000-${String(roots.length).padStart(12, '0')}`
  const path = join(root, `${Math.random().toString(36).slice(2)}.jsonl`)
  await writeFile(path, `${userRecord(0, 'generation fixture', sessionId)}\n`)
  const unregister = registerSessionSearchIndexConsumer(store)
  try {
    await parseTranscript(path)
  } finally {
    unregister()
  }
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

it('starts a new generation on every open, so a cursor cannot outlive a crash', async () => {
  const root = await tempRoot()
  const path = join(root, 'index.sqlite')
  const first = new SessionSearchStore(path)
  const firstGeneration = first.generation
  first.close()

  const second = new SessionSearchStore(path)
  try {
    // Why not merely "different": the value is persisted and monotone, so a
    // generation can never be reused for content that has moved on.
    expect(second.generation).toBeGreaterThan(firstGeneration)
  } finally {
    second.close()
  }
})

it('moves the generation forward when a proven deletion retires a session', async () => {
  const root = await tempRoot()
  const store = new SessionSearchStore(join(root, 'index.sqlite'), (error) => {
    throw error
  })
  try {
    store.removeFile('/synthetic/absent.jsonl')
    const afterRemove = store.generation
    store.removeFile('/synthetic/absent-two.jsonl')
    expect(store.generation).toBeGreaterThan(afterRemove)
  } finally {
    store.close()
  }
})
