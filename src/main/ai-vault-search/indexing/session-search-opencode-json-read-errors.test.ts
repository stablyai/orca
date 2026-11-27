import { mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resetSessionParseCacheForTests } from '../../ai-vault/parse-cache/session-parse-cache-store'
import { withFullFirstUserPromptCapture } from '../../ai-vault/prompts/session-scanner-first-user-prompt-capture'
import { scanAiVaultSessions } from '../../ai-vault/session-scanner'
import { resetTranscriptConsumersForTests } from '../../ai-vault/transcripts/session-transcript-consumers'
import * as transcriptFs from '../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
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
let storage: string
let messages: string
let part: string

async function put(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value))
}

beforeEach(async () => {
  resetSessionParseCacheForTests()
  harness = await openSessionSearchIndexerHarness('ss-opencode-read-errors')
  storage = harness.roots.opencodeStorageDir!
  messages = join(storage, 'message', 'ses_retry')
  part = join(storage, 'part', 'msg_user', 'prt_01.json')
  store = new SessionSearchStore(harness.databasePath)
  await put(join(storage, 'session', 'project', 'ses_retry.json'), {
    id: 'ses_retry',
    title: 'Saved conversation',
    directory: harness.root,
    time: { created: 1784109600000, updated: 1784109600000 }
  })
  await put(join(messages, 'msg_user.json'), {
    id: 'msg_user',
    sessionID: 'ses_retry',
    role: 'user',
    time: { created: 1784109600000 }
  })
  await put(part, { id: 'prt_01', type: 'text', text: 'Recovered prompt' })
})

afterEach(async () => {
  vi.restoreAllMocks()
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
  store.close()
  await harness.cleanup()
})

function history() {
  return withFullFirstUserPromptCapture(() =>
    scanAiVaultSessions({ ...harness.roots, unlimited: true })
  )
}

function pass(): Promise<unknown> {
  return runSessionSearchPass({
    store,
    roots: harness.roots,
    full: true,
    recentPerAgent: Number.POSITIVE_INFINITY,
    listings: new SessionSearchDirectoryListings()
  })
}

function matches(query: string): string[] {
  return harness.write((db) =>
    new SessionSearchEngine(db).search({ query }).hits.map((hit) => hit.sessionId)
  )
}

it('retries History and search after part I/O errors without a source-stat change', async () => {
  // A malformed part remains skippable while a refused read must remain retryable.
  await writeFile(join(dirname(part), 'prt_bad.json'), '{')
  const before = await stat(part)
  const read = transcriptFs.wslGatedReadFile
  let blocked = true
  let code = 'EIO'
  vi.spyOn(transcriptFs, 'wslGatedReadFile').mockImplementation(async (...args) => {
    if (args[0] === part && blocked) {
      throw Object.assign(new Error('Part read refused'), { code })
    }
    return read(...args)
  })

  await history()
  blocked = false
  expect.soft((await history()).sessions[0]?.firstUserPrompt).toBe('Recovered prompt')

  registerSessionSearchIndexConsumer(store)
  blocked = true
  code = 'EACCES'
  await pass()
  expect(matches('Recovered')).toEqual([])
  blocked = false
  await pass()
  expect.soft(matches('Recovered')).toEqual(['ses_retry'])

  const after = await stat(part)
  expect([after.size, after.mtimeMs, after.ctimeMs]).toEqual([
    before.size,
    before.mtimeMs,
    before.ctimeMs
  ])
})

it('keeps inline sessions visible and tracks fallback parts by the safe message id', async () => {
  await rm(messages, { recursive: true })
  for (const [name, record] of [
    ['inline', { id: 'msg_inline', role: 'user', content: 'Inline prompt' }],
    ['empty_string', { id: 'msg_empty_string', role: 'assistant', content: '' }],
    ['empty_array', { id: 'msg_empty_array', role: 'assistant', content: [] }],
    ['ignored', { id: 'msg_ignored', role: 'system' }],
    ['unsafe', { id: '../escape', role: 'assistant' }],
    ['different_filename', { id: 'msg_fallback', role: ' assistant ', content: null }]
  ] as const) {
    await put(join(messages, `${name}.json`), record)
  }
  const fallback = join(storage, 'part', 'msg_fallback')
  const reply = join(fallback, 'prt_01.json')
  await put(reply, { id: 'prt_01', type: 'text', text: 'Initial reply' })
  const readdir = transcriptFs.wslGatedReaddir
  vi.spyOn(transcriptFs, 'wslGatedReaddir').mockImplementation(async (...args) => {
    if (args[0].startsWith(join(storage, 'part') + sep) && args[0] !== fallback) {
      throw Object.assign(new Error('Unused part directory refused'), { code: 'EACCES' })
    }
    return readdir(...args)
  })

  const first = await history()
  expect(first.sessions.map((session) => session.sessionId)).toEqual(['ses_retry'])
  expect(first.sessions[0]?.firstUserPrompt).toBe('Inline prompt')
  expect(first.sessions[0]?.previewMessages.map(({ text }) => text).sort()).toEqual([
    'Initial reply',
    'Inline prompt'
  ])

  const before = await stat(reply)
  await put(reply, { id: 'prt_01', type: 'text', text: 'Updated reply' })
  const later = new Date(before.mtimeMs + 4_000)
  await utimes(reply, later, later)
  expect((await history()).sessions[0]?.previewMessages.map(({ text }) => text).sort()).toEqual([
    'Inline prompt',
    'Updated reply'
  ])
})
