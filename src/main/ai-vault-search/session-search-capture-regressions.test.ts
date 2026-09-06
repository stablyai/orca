import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionSearchStore } from './session-search-store'
import { SessionSearchService } from './session-search-service'
import { registerSessionSearchIndexSink } from '../ai-vault/session-search-capture'
import {
  parseAgentSessionFileCached,
  resetSessionParseCacheForTests
} from '../ai-vault/session-scanner-parse-cache'
import { isolatedScanRoots } from '../ai-vault/session-scanner-test-fixtures'
import {
  sessionCandidate,
  userRecord,
  assistantRecord,
  codexRolloutLines,
  CLAUDE_SESSION_ID,
  CODEX_SESSION_ID,
  CODEX_ROLLOUT_FILE
} from './session-search-transcript-fixtures'
let root: string
let store: SessionSearchStore
beforeEach(async () => {
  resetSessionParseCacheForTests()
  root = await mkdtemp(join(tmpdir(), 'ss-capture-audit-'))
  store = new SessionSearchStore(join(root, 'index.sqlite'))
  registerSessionSearchIndexSink(store)
})
afterEach(async () => {
  registerSessionSearchIndexSink(null)
  store.close()
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})
it('retains indexed rows when two scanner lanes consume the same append', async () => {
  const path = join(root, `${CLAUDE_SESSION_ID}.jsonl`)
  await writeFile(path, `${userRecord(0, 'synthetic alpha marker')}\n`)
  await parseAgentSessionFileCached(await sessionCandidate('claude', path), process.platform)
  await appendFile(path, `${assistantRecord(1, 'synthetic omega marker')}\n`)
  const candidate = await sessionCandidate('claude', path)
  await Promise.all([
    parseAgentSessionFileCached(candidate, process.platform),
    parseAgentSessionFileCached(candidate, process.platform)
  ])
  expect(store.search({ query: 'omega' }).hits).toHaveLength(1)
})
it('refreshes indexed Codex metadata when the title index changes', async () => {
  const path = join(root, CODEX_ROLLOUT_FILE)
  await writeFile(
    path,
    `${codexRolloutLines(['echo'], 'synthetic output', 'synthetic needle').join('\n')}\n`
  )
  const candidate = await sessionCandidate('codex', path, root)
  await parseAgentSessionFileCached(candidate, process.platform)
  await writeFile(
    join(root, 'session_index.jsonl'),
    `${JSON.stringify({ id: CODEX_SESSION_ID, thread_name: 'Renamed synthetic title' })}\n`
  )
  const listed = await parseAgentSessionFileCached(candidate, process.platform)
  expect(listed?.title).toBe('Renamed synthetic title')
  expect(store.search({ query: 'needle' }).hits[0]?.title).toBe('Renamed synthetic title')
})
it('redacts credential-shaped content copied into session titles', async () => {
  const fakeKey = `sk-${'x'.repeat(40)}`
  const path = join(root, `${CLAUDE_SESSION_ID}.jsonl`)
  await writeFile(path, `${userRecord(0, `synthetic needle ${fakeKey}`)}\n`)
  await parseAgentSessionFileCached(await sessionCandidate('claude', path), process.platform)
  const body = store.db.prepare('SELECT user_text FROM messages_fts').get() as { user_text: string }
  expect(body.user_text).not.toContain(fakeKey)
  const row = store.db.prepare('SELECT title FROM sessions').get() as { title: string }
  expect(row.title).not.toContain(fakeKey)
})
it('does not log malformed JSON transcript excerpts during backfill', async () => {
  const roots = isolatedScanRoots(root)
  await mkdir(roots.geminiSessionsDir, { recursive: true })
  await writeFile(
    join(roots.geminiSessionsDir, 'malformed.json'),
    'private_synthetic_marker malformed'
  )
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const service = new SessionSearchService({
    databasePath: join(root, 'other.sqlite'),
    enabled: true,
    historyDays: null
  })
  try {
    await service.ensureBackfill(roots)
    const logged = warn.mock.calls
      .flat()
      .map((value) => (value instanceof Error ? value.message : String(value)))
      .join(' ')
    expect(logged).not.toContain('private_sy')
  } finally {
    service.dispose()
  }
})
