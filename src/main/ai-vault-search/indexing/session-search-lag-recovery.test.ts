import { appendFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { resetSessionParseCacheForTests } from '../../ai-vault/parse-cache/session-parse-cache-store'
import { resetTranscriptConsumersForTests } from '../../ai-vault/transcripts/session-transcript-consumers'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import { runSessionSearchIndexPass } from './session-search-index-pass'
import { openSessionSearchIndexFile } from '../storage/session-search-index-test-fixture'
import { SessionSearchStore } from '../storage/session-search-store'
import { parseTranscript, sessionCandidate, userRecord } from './session-search-transcript-fixtures'

it('recovers a declined append through its proven prefix while the transcript keeps growing', async () => {
  const index = await openSessionSearchIndexFile('ss-lag-recovery')
  const store = new SessionSearchStore(index.path, (error) => {
    throw error
  })
  const path = join(dirname(index.path), 'transcript.jsonl')
  let unregister = registerSessionSearchIndexConsumer(store)
  try {
    await writeFile(path, `${userRecord(0, 'originalneedle')}\n`)
    await parseTranscript(path)
    // Let listing advance its resume point while the index consumer declines the read.
    unregister()
    await appendFile(path, `${userRecord(1, 'missedneedle')}\n`)
    await parseTranscript(path)
    unregister = registerSessionSearchIndexConsumer(store)
    const pass = async () => {
      const candidate = await sessionCandidate('claude', path)
      await runSessionSearchIndexPass(store, [candidate], {
        rows: new Map(store.files().map((row) => [row.path, row]))
      })
      return candidate
    }
    await appendFile(path, `${userRecord(2, 'stillgrowingneedle')}\n`)
    await pass()
    expect(store.files()[0].state).toBe('current')
    await appendFile(path, `${userRecord(3, 'recoveredneedle')}\n`)
    const candidate = await pass()
    expect(store.coversTranscript(candidate)).toBe(true)
    expect(index.db.prepare('SELECT user_text FROM messages_fts ORDER BY rowid').all()).toEqual([
      { user_text: 'originalneedle' },
      { user_text: 'missedneedle' },
      { user_text: 'stillgrowingneedle' },
      { user_text: 'recoveredneedle' }
    ])
  } finally {
    unregister()
    resetTranscriptConsumersForTests()
    resetSessionParseCacheForTests()
    store.close()
    await index.close()
  }
})
