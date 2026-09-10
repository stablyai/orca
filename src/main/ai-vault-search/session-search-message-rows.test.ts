import { expect, it } from 'vitest'
import type { TranscriptMessage } from '../ai-vault/session-transcript-consumers'
import { insertSearchMessage, searchMessageRows } from './session-search-message-rows'
import {
  openSessionSearchIndexFile,
  type SessionSearchIndexFile
} from './session-search-index-test-fixture'

/** Every column of both FTS tables, so an assertion cannot miss the shadow terms. */
async function indexedColumns(
  index: SessionSearchIndexFile,
  message: TranscriptMessage
): Promise<string[]> {
  for (const row of searchMessageRows([message])) {
    insertSearchMessage(index.db, 1, row)
  }
  const full = index.db
    .prepare('SELECT user_text, assistant_text, tool_text, identifiers FROM messages_fts')
    .all() as Record<string, string>[]
  const conversation = index.db
    .prepare('SELECT user_text, assistant_text FROM conversation_fts')
    .all() as Record<string, string>[]
  return [...full, ...conversation].flatMap((row) => Object.values(row))
}

it('splits an oversized message on a line boundary and keeps every character', () => {
  const line = `${'padding '.repeat(11)}word\n`
  const text = line.repeat(400)
  const chunks = [...searchMessageRows([{ role: 'user', text, timestamp: null }])].map(
    (row) => row.text
  )

  expect(chunks.length).toBeGreaterThan(1)
  expect(chunks.join('')).toBe(text)
  for (const chunk of chunks) {
    expect(chunk.length).toBeLessThanOrEqual(8000)
    expect(chunk.endsWith('\n')).toBe(true)
  }
})

it('leaves a message that fits as a single row', () => {
  const rows = [...searchMessageRows([{ role: 'user', text: 'short enough', timestamp: null }])]
  expect(rows.map((row) => row.text)).toEqual(['short enough'])
})

it('keeps a tool row out of the conversation half', async () => {
  const index = await openSessionSearchIndexFile('ss-message-rows-tool')
  try {
    for (const row of searchMessageRows([
      { role: 'tool', text: 'rg pericardium', timestamp: null }
    ])) {
      insertSearchMessage(index.db, 1, row)
    }
    expect(index.db.prepare('SELECT count(*) AS n FROM messages_fts').get()).toEqual({ n: 1 })
    expect(index.db.prepare('SELECT count(*) AS n FROM conversation_fts').get()).toEqual({ n: 0 })
  } finally {
    await index.close()
  }
})

it('stores a chunk exactly as the transcript wrote it', async () => {
  const index = await openSessionSearchIndexFile('ss-rows-verbatim')
  try {
    const text = 'deploy with AKIAIOSFODNN7EXAMPLE and the resolveTerminalPath fix'
    const stored = await indexedColumns(index, {
      role: 'assistant',
      text,
      timestamp: null
    })

    // The index is a second copy of content the user already holds in plaintext,
    // so it neither rewrites nor drops any of it.
    expect(stored).toContain(text)
    // Identifier shadow terms come off that same raw chunk.
    expect(stored.some((column) => column.includes('resolve terminal path'))).toBe(true)
  } finally {
    await index.close()
  }
})
