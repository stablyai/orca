import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetSessionParseCacheForTests } from '../../ai-vault/parse-cache/session-parse-cache-store'
import {
  registerTranscriptConsumer,
  resetTranscriptConsumersForTests,
  type TranscriptSessionIdentity
} from '../../ai-vault/transcripts/session-transcript-consumers'
import '../../ai-vault/transcripts/session-transcript-reader'
import SyncDatabase from '../../sqlite/sync-database'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import { SessionSearchStore } from '../storage/session-search-store'
import {
  assistantRecord,
  CLAUDE_SESSION_ID as SESSION_ID,
  CODEX_ROLLOUT_FILE,
  CODEX_SESSION_ID,
  codexRolloutLines,
  parseTranscript,
  userRecord
} from './session-search-transcript-fixtures'

let tempRoots: string[] = []
let store: SessionSearchStore
let reader: SyncDatabase
let errors: unknown[]

beforeEach(async () => {
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  errors = []
  const path = join(await makeTempDir(), 'index.sqlite')
  store = new SessionSearchStore(path, (error) => errors.push(error))
  registerSessionSearchIndexConsumer(store)
  reader = new SyncDatabase(path, { readonly: true })
})

afterEach(async () => {
  resetTranscriptConsumersForTests()
  reader.close()
  store.close()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function makeTempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-session-search-live-'))
  tempRoots.push(root)
  return root
}

function sessionsMatching(term: string): string[] {
  return (
    reader
      .prepare(
        `SELECT DISTINCT s.session_id AS id FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         JOIN sessions s ON s.id = m.session_row_id
         WHERE messages_fts MATCH ? ORDER BY s.session_id`
      )
      .all(term) as { id: string }[]
  ).map((row) => row.id)
}

it('keeps the prompt searchable while excluding tool results', async () => {
  const root = await makeTempDir()
  const codexHome = await makeTempDir()
  const path = join(root, CODEX_ROLLOUT_FILE)
  await writeFile(
    path,
    `${codexRolloutLines(
      ['rg', 'pericardium'],
      `outputonly ${'padding '.repeat(600)}tailonly`,
      'promptonly search for the module'
    ).join('\n')}\n`
  )
  await parseTranscript(path, 'codex', codexHome)
  expect(errors).toEqual([])

  expect(sessionsMatching('pericardium')).toHaveLength(0)
  expect(sessionsMatching('outputonly')).toHaveLength(0)
  expect(sessionsMatching('tailonly')).toHaveLength(0)
  expect(sessionsMatching('rg')).toHaveLength(0)
  expect(sessionsMatching('{user_text assistant_text}: promptonly')).toHaveLength(1)
  expect(sessionsMatching('{user_text assistant_text}: outputonly')).toHaveLength(0)
  expect(sessionsMatching('{user_text assistant_text}: rg')).toHaveLength(0)
})

function recordIdentityPerMessage(): (TranscriptSessionIdentity | null)[] {
  const seen: (TranscriptSessionIdentity | null)[] = []
  registerTranscriptConsumer({
    beginRead: (start) => ({
      message: () => {
        seen.push(start.identity?.() ?? null)
      },
      finish: () => undefined
    })
  })
  return seen
}

it('names the session mid-read, before the reader has finished the file', async () => {
  const root = await makeTempDir()
  const path = join(root, `${SESSION_ID}.jsonl`)
  await writeFile(
    path,
    `${[
      userRecord(0, 'find the flaky terminal reattach'),
      assistantRecord(1, 'look at resolveTerminalPath first')
    ].join('\n')}\n`
  )
  const seen = recordIdentityPerMessage()
  await parseTranscript(path)

  expect(seen.length).toBeGreaterThan(0)
  expect(seen[0]).toMatchObject({
    sessionId: SESSION_ID,
    cwd: '/repo/app',
    createdAt: expect.any(String)
  })
})

it('names a Codex session mid-read from its own opening record', async () => {
  const root = await makeTempDir()
  const codexHome = await makeTempDir()
  const path = join(root, CODEX_ROLLOUT_FILE)
  await writeFile(
    path,
    `${codexRolloutLines(['rg', 'pericardium'], 'src/main/pericardium.ts:12: match', 'search for the pericardium module').join('\n')}\n`
  )
  const seen = recordIdentityPerMessage()
  await parseTranscript(path, 'codex', codexHome)

  // Exercise Codex’s separate resumable parser as well as the shared accumulator.
  expect(seen[0]).toMatchObject({
    sessionId: CODEX_SESSION_ID,
    cwd: '/repo/app'
  })
})
