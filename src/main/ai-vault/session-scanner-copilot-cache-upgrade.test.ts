import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { buildAiVaultResumeCommand } from '../../shared/ai-vault-resume-command'
import SyncDatabase from '../sqlite/sync-database'
import { registerSessionSearchIndexConsumer } from '../ai-vault-search/session-search-index-consumer'
import { replayTranscriptRead } from '../ai-vault-search/session-search-index-test-fixture'
import { SessionSearchStore } from '../ai-vault-search/session-search-store'
import { sessionCandidate } from '../ai-vault-search/session-search-transcript-fixtures'
import { SessionParseCacheDatabase } from './session-parse-cache-database'
import {
  initSessionParseCachePersistence,
  resetSessionParseCachePersistenceForTests
} from './session-parse-cache-persistence'
import {
  createSessionParseStats,
  parseAgentSessionFileCached,
  resetSessionParseCacheForTests
} from './session-scanner-parse-cache'
import { parseCopilotSessionFile } from './session-scanner-copilot-parser'
import { resetTranscriptConsumersForTests } from './session-transcript-consumers'
import type { PersistedSessionParseCacheEntry } from './session-parse-cache-store'

let root: string | undefined
let store: SessionSearchStore | undefined

afterEach(async () => {
  resetTranscriptConsumersForTests()
  store?.close()
  resetSessionParseCacheForTests()
  resetSessionParseCachePersistenceForTests()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

function markPreviousVersion(path: string, version: number): void {
  const db = new SyncDatabase(path)
  try {
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(version))
  } finally {
    db.close()
  }
}

it('repairs unchanged Copilot metadata and search messages cached before the parser fix', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-copilot-cache-upgrade-'))
  const path = join(root, 'events.jsonl')
  const prompt = 'fix the login bug'
  const transformed = '<current_datetime>2026-10-19</current_datetime> injected context'
  await writeFile(
    path,
    `${[
      { type: 'session.start', data: { sessionId: 'copilot-session', context: { cwd: '/repo' } } },
      { type: 'user.message', data: { content: prompt, transformedContent: transformed } }
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')}\n`
  )
  const candidate = await sessionCandidate('copilot', path)
  const sizeBytes = candidate.file.sizeBytes
  if (sizeBytes === undefined) {
    throw new Error('Missing Copilot fixture size')
  }
  const parsed = await parseCopilotSessionFile(candidate.file, 'linux')
  if (!parsed) {
    throw new Error('Missing Copilot fixture session')
  }
  const stale = {
    ...parsed,
    cwd: null,
    title: transformed,
    resumeCommand: buildAiVaultResumeCommand({
      agent: 'copilot',
      sessionId: parsed.sessionId,
      cwd: null,
      platform: 'linux'
    })
  }
  const parsePath = join(root, 'session-parse-cache.sqlite')
  const parseCache = new SessionParseCacheDatabase(parsePath)
  const entry: PersistedSessionParseCacheEntry = {
    mtimeMs: candidate.file.mtimeMs,
    sizeBytes,
    platform: 'linux',
    session: stale
  }
  parseCache.write([[path, entry]], Date.now())
  parseCache.close()
  markPreviousVersion(parsePath, 5)

  const searchPath = join(root, 'search.sqlite')
  store = new SessionSearchStore(searchPath)
  const unregister = registerSessionSearchIndexConsumer(store)
  replayTranscriptRead({
    candidate,
    messages: [{ role: 'user', text: transformed, timestamp: null }],
    outcome: { session: stale, byteOffset: sizeBytes }
  })
  unregister()
  store.close()
  markPreviousVersion(searchPath, 7)

  initSessionParseCachePersistence({
    filePath: join(root, 'session-parse-cache.json'),
    appVersion: 'fixed'
  })
  store = new SessionSearchStore(searchPath)
  registerSessionSearchIndexConsumer(store)
  const stats = createSessionParseStats()
  const session = await parseAgentSessionFileCached(candidate, 'linux', stats)

  expect.soft(stats.fullParses).toBe(1)
  expect.soft(session?.cwd).toBe('/repo')
  expect.soft(session?.title).toBe(prompt)
  expect.soft(session?.resumeCommand).toContain("cd '/repo'")
  expect.soft(store.connection.prepare('SELECT cwd, title FROM sessions').get()).toEqual({
    cwd: '/repo',
    title: prompt
  })
  expect(store.connection.prepare('SELECT user_text FROM messages_fts').all()).toEqual([
    { user_text: prompt }
  ])
})
