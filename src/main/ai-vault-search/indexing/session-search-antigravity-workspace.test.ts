import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { writeAntigravityTranscript } from '../../ai-vault/scanner-fixtures/session-scanner-test-fixtures'
import { resetTranscriptConsumersForTests } from '../../ai-vault/transcripts/session-transcript-consumers'
import { SessionSearchDirectoryListings } from '../discovery/session-search-directory-listings'
import { SessionSearchEngine } from '../query/session-search-engine'
import { SessionSearchStore } from '../storage/session-search-store'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import {
  openSessionSearchIndexerHarness,
  type SessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'
import { runSessionSearchPass } from './session-search-pass'

let harness: SessionSearchIndexerHarness
let store: SessionSearchStore
let brain: string
let workspace: string

beforeEach(async () => {
  harness = await openSessionSearchIndexerHarness('ss-antigravity-workspace')
  brain = join(harness.root, '.gemini', 'antigravity-cli', 'brain')
  workspace = join(harness.root, 'worktree')
  await mkdir(dirname(harness.databasePath), { recursive: true })
  store = new SessionSearchStore(harness.databasePath)
  registerSessionSearchIndexConsumer(store)
})

afterEach(async () => {
  resetTranscriptConsumersForTests()
  store.close()
  await harness.cleanup()
})

function pass(): Promise<unknown> {
  return runSessionSearchPass({
    store,
    roots: { ...harness.roots, antigravityBrainDir: brain, antigravityAppHome: harness.root },
    full: true,
    recentPerAgent: Number.POSITIVE_INFINITY,
    listings: new SessionSearchDirectoryListings()
  })
}

function history(entries: Record<string, string>): Promise<void> {
  const cache = join(dirname(brain), 'cache')
  return mkdir(cache, { recursive: true }).then(() =>
    writeFile(join(cache, 'last_conversations.json'), JSON.stringify(entries))
  )
}

function prompt(text: string) {
  return {
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    created_at: '2026-10-02T01:00:00Z',
    content: `<USER_REQUEST>${text}</USER_REQUEST>`
  }
}

function hits(query: string, cwd?: string): string[] {
  return harness.read((db) =>
    new SessionSearchEngine(db)
      .search({ query, filters: { scopePaths: cwd ? [cwd] : undefined } })
      .hits.map((hit) => hit.filePath)
      .sort()
  )
}

it('attributes an unchanged Antigravity transcript when its workspace mapping arrives', async () => {
  const transcript = await writeAntigravityTranscript(brain, 'late', [
    prompt('lateworkspaceneedle')
  ])
  const mtime = (await stat(transcript)).mtimeMs
  await pass()
  expect(hits('lateworkspaceneedle')).toEqual([transcript])
  expect(hits('lateworkspaceneedle', workspace)).toEqual([])

  await history({ [workspace]: 'late' })
  await pass()
  expect(hits('lateworkspaceneedle', workspace)).toEqual([transcript])
  expect(hits('lateworkspaceneedle', `${workspace}-other`)).toEqual([])
  expect(hits('lateworkspaceneedle')).toEqual([transcript])
  expect((await stat(transcript)).mtimeMs).toBe(mtime)
})

it.each(['append', 'rewrite'] as const)(
  'replaces the readable Antigravity fallback after the full transcript %s',
  async (change) => {
    const fallback = await writeAntigravityTranscript(brain, 'alpha', [
      prompt('sharedneedle fallbackneedle')
    ])
    const full = join(dirname(fallback), 'transcript_full.jsonl')
    await writeFile(full, '{}\n')
    const other = await writeAntigravityTranscript(brain, 'beta', [
      prompt('sharedneedle anotherneedle')
    ])
    const otherWorkspace = `${workspace}-other`
    await history({ [workspace]: 'alpha', [otherWorkspace]: 'beta' })
    await pass()
    expect(hits('sharedneedle', workspace)).toEqual([fallback])
    expect(hits('sharedneedle')).toEqual([fallback, other].sort())

    const update = change === 'append' ? appendFile : writeFile
    await update(full, `${JSON.stringify(prompt('sharedneedle preferredneedle'))}\n`)
    await pass()
    if (change === 'rewrite') {
      await pass()
    }
    expect(hits('sharedneedle', workspace)).toEqual([full])
    expect(hits('sharedneedle', otherWorkspace)).toEqual([other])
    expect(hits('sharedneedle')).toEqual([full, other].sort())
    expect(hits('fallbackneedle')).toEqual([])
  }
)
