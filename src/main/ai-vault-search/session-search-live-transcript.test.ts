import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import {
  registerTranscriptConsumer,
  resetTranscriptConsumersForTests,
  type TranscriptSessionIdentity
} from '../ai-vault/session-transcript-consumers'
import { requestWholeTranscriptRead } from '../ai-vault/session-transcript-reader'
import SyncDatabase from '../sqlite/sync-database'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import { SessionSearchStore } from './session-search-store'
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

it('indexes a Claude transcript through the reader and resumes on append', async () => {
  const root = await makeTempDir()
  const path = join(root, `${SESSION_ID}.jsonl`)
  await writeFile(
    path,
    `${[
      userRecord(0, 'find the flaky terminal reattach'),
      assistantRecord(1, 'look at resolveTerminalPath first')
    ].join('\n')}\n`
  )
  await parseTranscript(path)
  expect(errors).toEqual([])
  expect(sessionsMatching('reattach')).toEqual([SESSION_ID])
  expect(sessionsMatching('terminal')).toEqual([SESSION_ID])

  await appendFile(path, `${assistantRecord(2, 'the zygomorphic follow-up landed')}\n`)
  const resumed = await parseTranscript(path)
  expect(resumed.stats).toMatchObject({ incremental: 1, fullParses: 0 })
  expect(errors).toEqual([])
  expect(sessionsMatching('zygomorphic')).toEqual([SESSION_ID])
  expect(reader.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({
    n: 1
  })
})

it('keeps a tool result searchable but out of the conversation half', async () => {
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

  expect(sessionsMatching('pericardium')).toHaveLength(1)
  expect(sessionsMatching('outputonly')).toHaveLength(1)
  expect(sessionsMatching('tailonly')).toHaveLength(0)
  expect(sessionsMatching('rg')).toHaveLength(1)
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

it('indexes a file the session list already read past, once a whole read is asked for', async () => {
  const root = await makeTempDir()
  const path = join(root, `${SESSION_ID}.jsonl`)
  await writeFile(path, `${userRecord(0, 'the opening prompt')}\n`)

  // Simulate first enablement with a warm session-list cache and an empty index.
  resetTranscriptConsumersForTests()
  await parseTranscript(path)
  registerSessionSearchIndexConsumer(store)

  await appendFile(path, `${assistantRecord(1, 'a zygomorphic reply')}\n`)
  const appended = await parseTranscript(path)
  expect(appended.stats).toMatchObject({ incremental: 1, fullParses: 0 })
  // The index never saw the preceding bytes, so it must decline this append.
  expect(sessionsMatching('zygomorphic')).toEqual([])

  expect(store.files()).toEqual([])
  requestWholeTranscriptRead(path)

  const reread = await parseTranscript(path)
  expect(reread.stats).toMatchObject({ incremental: 0, fullParses: 1 })
  expect(errors).toEqual([])
  expect(sessionsMatching('zygomorphic')).toEqual([SESSION_ID])
  expect(sessionsMatching('opening')).toEqual([SESSION_ID])
  expect(store.files().map((row) => row.state)).toEqual(['current'])
})
