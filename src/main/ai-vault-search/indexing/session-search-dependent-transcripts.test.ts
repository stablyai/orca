import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { parseAgentSessionFileCached } from '../../ai-vault/parse-cache/session-scanner-parse-cache'
import { resetSessionParseCacheForTests } from '../../ai-vault/parse-cache/session-parse-cache-store'
import { resetCodexSessionIndexTitleCacheForTests } from '../../ai-vault/scanners/codex/session-scanner-codex-title-index'
import type { SessionFileCandidate } from '../../ai-vault/session-scanner-types'
import { resetTranscriptConsumersForTests } from '../../ai-vault/transcripts/session-transcript-consumers'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import {
  openSessionSearchIndexFile,
  type SessionSearchIndexFile
} from '../storage/session-search-index-test-fixture'
import { SessionSearchStore } from '../storage/session-search-store'
import {
  CODEX_ROLLOUT_FILE,
  CODEX_SESSION_ID,
  codexRolloutLines,
  sessionCandidate
} from './session-search-transcript-fixtures'

let index: SessionSearchIndexFile
let store: SessionSearchStore
let root: string
let errors: unknown[]

beforeEach(async () => {
  resetTranscriptConsumersForTests()
  resetCodexSessionIndexTitleCacheForTests()
  index = await openSessionSearchIndexFile('ss-dependent-transcripts')
  root = dirname(index.path)
  errors = []
  store = new SessionSearchStore(index.path, (error) => errors.push(error))
  registerSessionSearchIndexConsumer(store)
})

afterEach(async () => {
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
  resetCodexSessionIndexTitleCacheForTests()
  store.close()
  await index.close()
})

async function writeSource(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

async function coldRead(candidate: SessionFileCandidate) {
  resetSessionParseCacheForTests()
  const session = await parseAgentSessionFileCached(candidate, process.platform)
  expect(errors).toEqual([])
  expect(session).not.toBeNull()
  return session
}

function matches(term: string): unknown {
  return index.db
    .prepare(
      `SELECT count(*) AS n FROM messages_fts
       JOIN messages m ON m.id = messages_fts.rowid
       JOIN sessions s ON s.id = m.session_row_id
       WHERE messages_fts MATCH ?`
    )
    .get(term)
}

it('updates the indexed Codex title when only session_index.jsonl changes', async () => {
  const home = join(root, 'codex')
  const path = join(home, 'sessions', CODEX_ROLLOUT_FILE)
  await writeSource(path, `${codexRolloutLines(['pwd'], '/repo/app', 'codexmessage').join('\n')}\n`)
  const titleIndex = join(home, 'session_index.jsonl')
  await writeSource(
    titleIndex,
    `${JSON.stringify({ id: CODEX_SESSION_ID, thread_name: 'Original' })}\n`
  )
  const candidate = await sessionCandidate('codex', path, home)
  candidate.file.sidecar = 'none'
  await coldRead(candidate)
  expect(index.db.prepare('SELECT title FROM sessions').get()).toEqual({ title: 'Original' })

  await writeSource(
    titleIndex,
    `${JSON.stringify({ id: CODEX_SESSION_ID, thread_name: 'Renamed conversation' })}\n`
  )
  expect((await sessionCandidate('codex', path, home)).file).toEqual({
    ...candidate.file,
    sidecar: undefined
  })
  expect(await coldRead(candidate)).toMatchObject({ title: 'Renamed conversation' })
  expect(index.db.prepare('SELECT title FROM sessions').get()).toEqual({
    title: 'Renamed conversation'
  })
  expect(matches('codexmessage')).toEqual({ n: 1 })
})
