import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { resetSessionParseCacheForTests } from '../../ai-vault/parse-cache/session-parse-cache-store'
import { resetTranscriptConsumersForTests } from '../../ai-vault/transcripts/session-transcript-consumers'
import { SessionSearchStore } from '../storage/session-search-store'
import { openSessionSearchIndexFile } from '../storage/session-search-index-test-fixture'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import { parseTranscript } from './session-search-transcript-fixtures'

it('refreshes an indexed Trae title after only its external title index changes', async () => {
  const index = await openSessionSearchIndexFile('ss-trae-title')
  const store = new SessionSearchStore(index.path, (error) => {
    throw error
  })
  const home = dirname(index.path)
  const path = join(home, 'sessions', 'rollout-title-thread.jsonl')
  const unregister = registerSessionSearchIndexConsumer(store)
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      `${[
        { type: 'session_meta', payload: { id: 'title-thread', cwd: '/workspace' } },
        {
          type: 'response_item',
          payload: { type: 'message', id: 'prompt', role: 'user', content: 'Find the rule page' }
        }
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')}\n`
    )
    const writeTitle = (title: string) =>
      writeFile(
        join(home, 'session_index.jsonl'),
        `${JSON.stringify({ id: 'title-thread', thread_name: title })}\n`
      )
    await writeTitle('Rule page')
    await parseTranscript(path, 'trae')
    expect(index.db.prepare('SELECT title FROM sessions').all()).toEqual([{ title: 'Rule page' }])
    await writeTitle('Updated rule page')
    resetSessionParseCacheForTests()
    await parseTranscript(path, 'trae')
    expect(index.db.prepare('SELECT title FROM sessions').all()).toEqual([
      { title: 'Updated rule page' }
    ])
    expect(
      index.db
        .prepare(`
      SELECT fts.user_text FROM messages_fts fts
      JOIN messages m ON m.id = fts.rowid
      JOIN sessions s ON s.id = m.session_row_id
    `)
        .all()
    ).toEqual([{ user_text: 'Find the rule page' }])
  } finally {
    unregister()
    resetTranscriptConsumersForTests()
    resetSessionParseCacheForTests()
    store.close()
    await index.close()
  }
})
