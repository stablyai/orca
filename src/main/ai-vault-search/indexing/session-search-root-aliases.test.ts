import { mkdir, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetTranscriptConsumersForTests } from '../../ai-vault/transcripts/session-transcript-consumers'
import { SessionSearchDirectoryListings } from '../discovery/session-search-directory-listings'
import { SessionSearchStore } from '../storage/session-search-store'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import {
  openSessionSearchIndexerHarness,
  writeClaudeTranscript,
  type SessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'
import { runSessionSearchPass } from './session-search-pass'

let harness: SessionSearchIndexerHarness
let store: SessionSearchStore

beforeEach(async () => {
  harness = await openSessionSearchIndexerHarness('ss-root-aliases')
  await mkdir(dirname(harness.databasePath), { recursive: true })
  store = new SessionSearchStore(harness.databasePath)
  registerSessionSearchIndexConsumer(store)
})

afterEach(async () => {
  resetTranscriptConsumersForTests()
  store.close()
  await harness.cleanup()
})

function pass(claudeProfileProjectsDirs: string[], claudeProjectsDir: string): Promise<unknown> {
  return runSessionSearchPass({
    store,
    roots: { ...harness.roots, claudeProjectsDir, claudeProfileProjectsDirs },
    full: true,
    recentPerAgent: Number.POSITIVE_INFINITY,
    listings: new SessionSearchDirectoryListings()
  })
}

it('retires rows indexed under a profile root that now aliases the shared Claude projects folder', async () => {
  const transcript = join(harness.claudeProjectDir, 'shared.jsonl')
  await writeClaudeTranscript(transcript, ['hello there'], 'shared')
  const alias = join(harness.root, 'profile', 'projects')
  await mkdir(dirname(alias), { recursive: true })
  await symlink(
    harness.roots.claudeProjectsDir,
    alias,
    process.platform === 'win32' ? 'junction' : 'dir'
  )

  // Older builds walked the alias as its own root and indexed its spelling of each transcript.
  await pass([alias], join(harness.root, 'unset-projects'))
  expect(store.files().map((row) => row.path)).toEqual([join(alias, 'project', 'shared.jsonl')])

  await pass([alias], harness.roots.claudeProjectsDir)
  expect(store.files().map((row) => row.path)).toEqual([transcript])
})
