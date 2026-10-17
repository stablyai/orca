import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import type SyncDatabase from '../sqlite/sync-database'
import { SessionSearchIndexer } from './session-search-indexer'
import {
  FakeSessionSearchClock,
  openSessionSearchIndexerHarness,
  writeClaudeTranscript,
  type SessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'
import { CLAUDE_SESSION_ID } from './session-search-transcript-fixtures'

let harness: SessionSearchIndexerHarness
let indexer: SessionSearchIndexer | null

beforeEach(async () => {
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  indexer = null
  harness = await openSessionSearchIndexerHarness('ss-cjk-indexing')
})

afterEach(async () => {
  indexer?.close()
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
  await harness.cleanup()
})

function sessionsContaining(substring: string): string[] {
  return harness.read((db: SyncDatabase) =>
    db
      .prepare(
        `SELECT DISTINCT s.session_id AS id FROM messages_cjk_fts
         JOIN messages m ON m.id = messages_cjk_fts.rowid
         JOIN sessions s ON s.id = m.session_row_id
         WHERE messages_cjk_fts MATCH ?`
      )
      .all(`"${substring}"`)
      .map((row) => String(row.id))
  )
}

it('indexes CJK text from a real transcript so a substring of it is searchable', async () => {
  await writeClaudeTranscript(
    join(harness.claudeProjectDir, `${CLAUDE_SESSION_ID}.jsonl`),
    ['它会把删除暂存进索引。按仓库约定提交'],
    CLAUDE_SESSION_ID
  )
  indexer = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: harness.roots,
    historyDays: null,
    clock: new FakeSessionSearchClock(),
    reconcileIntervalMs: 20_000,
    onError: (error) => {
      throw error
    }
  })
  await indexer.start()

  expect(sessionsContaining('删除暂存')).toEqual([CLAUDE_SESSION_ID])
  expect(sessionsContaining('仓库约定')).toEqual([CLAUDE_SESSION_ID])
  expect(sessionsContaining('不存在的词')).toEqual([])
})
