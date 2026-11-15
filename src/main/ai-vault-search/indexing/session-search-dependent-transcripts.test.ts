import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { parseAgentSessionFileCached } from '../../ai-vault/parse-cache/session-scanner-parse-cache'
import { resetSessionParseCacheForTests } from '../../ai-vault/parse-cache/session-parse-cache-store'
import { resetCodexSessionIndexTitleCacheForTests } from '../../ai-vault/scanners/codex/session-scanner-codex-title-index'
import type { SessionFileCandidate } from '../../ai-vault/session-scanner-types'
import { resetTranscriptConsumersForTests } from '../../ai-vault/transcripts/session-transcript-consumers'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import { runSessionSearchIndexPass } from './session-search-index-pass'
import {
  openSessionSearchIndexFile,
  type SessionSearchIndexFile
} from '../storage/session-search-index-test-fixture'
import { SessionSearchStore } from '../storage/session-search-store'
import {
  CODEX_ROLLOUT_FILE,
  CODEX_SESSION_ID,
  codexRolloutLines,
  recordTimestamp,
  sessionCandidate
} from './session-search-transcript-fixtures'

const ANTE_SESSION_ID = '0b5e1c2a-3d4f-4a5b-8c6d-7e8f9a0b1c2d'

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

it('rereads an Ante session whose transcript outran its unchanged meta.json', async () => {
  const directory = join(root, 'ante', 'sessions', ANTE_SESSION_ID)
  const metadataPath = join(directory, 'meta.json')
  const transcriptPath = join(directory, 'events.jsonl')
  await writeSource(
    metadataPath,
    JSON.stringify({ id: ANTE_SESSION_ID, dir: '/repo/app', first_user_message: 'ante' })
  )
  await writeSource(transcriptPath, anteEventLine('user', 'oldantemessage', 0))
  const first = await anteCandidate(metadataPath, transcriptPath)
  await runIndexPass([first])
  expect(matches('oldantemessage')).toEqual({ n: 1 })

  // Ante rewrites meta.json at turn end, so the transcript runs ahead of the stat this row keys on.
  await appendFile(transcriptPath, anteEventLine('assistant', 'newantemessage', 1))
  const grown = await anteCandidate(metadataPath, transcriptPath)
  expect(grown.file.mtimeMs).toBe(first.file.mtimeMs)
  expect(grown.file.sizeBytes).toBe(first.file.sizeBytes)
  expect(grown.file.sidecar).not.toEqual(first.file.sidecar)

  await runIndexPass([grown])
  expect(matches('newantemessage')).toEqual({ n: 1 })
})

/** Run the search pass the indexer runs, so the read decision is exercised as shipped. */
async function runIndexPass(candidates: SessionFileCandidate[]): Promise<void> {
  await runSessionSearchIndexPass(store, candidates, {
    rows: new Map(store.files().map((fileRow) => [fileRow.path, fileRow]))
  })
  expect(errors).toEqual([])
}

/** Ante discovery hands the parser the transcript as a sidecar of `meta.json`. */
async function anteCandidate(
  metadataPath: string,
  transcriptPath: string
): Promise<SessionFileCandidate> {
  const candidate = await sessionCandidate('ante', metadataPath)
  const sidecar = await stat(transcriptPath)
  candidate.file.sidecar = {
    path: transcriptPath,
    mtimeMs: sidecar.mtimeMs,
    sizeBytes: sidecar.size
  }
  return candidate
}

/** One `events.jsonl` record in Ante's externally tagged `{ Variant: payload }` shape. */
function anteEventLine(role: 'user' | 'assistant', text: string, eventIndex: number): string {
  return `${JSON.stringify({
    timestamp: recordTimestamp(eventIndex),
    id: `evt_${eventIndex}`,
    event: role === 'user' ? { UserInput: text } : { AgentMessage: text }
  })}\n`
}
