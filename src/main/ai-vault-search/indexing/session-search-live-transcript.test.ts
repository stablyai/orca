import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetSessionParseCacheForTests } from '../../ai-vault/parse-cache/session-parse-cache-store'
import { resetTranscriptConsumersForTests } from '../../ai-vault/transcripts/session-transcript-consumers'
import '../../ai-vault/transcripts/session-transcript-reader'
import SyncDatabase from '../../sqlite/sync-database'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import { SessionSearchStore } from '../storage/session-search-store'
import {
  CODEX_ROLLOUT_FILE,
  codexRolloutLines,
  parseTranscript
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
