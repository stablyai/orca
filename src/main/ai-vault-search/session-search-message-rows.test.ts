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

it('cuts at whitespace rather than through the word on the boundary', async () => {
  const index = await openSessionSearchIndexFile('ss-rows-whitespace')
  try {
    // The 8,000th character lands inside `pericardium`. Cutting at the target
    // would file `per` under one row and `icardium` under another, and the word
    // the user types would match neither.
    const text = `${' '.repeat(7997)}pericardium`
    const chunks = [...searchMessageRows([{ role: 'user', text, timestamp: null }])]
    expect(chunks.map((row) => row.text).join('')).toBe(text)
    for (const row of chunks) {
      insertSearchMessage(index.db, 1, row)
    }

    expect(
      index.db
        .prepare('SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?')
        .get('pericardium')
    ).toEqual({ n: 1 })
  } finally {
    await index.close()
  }
})

it('backs up to any whitespace, not only a newline', () => {
  // An ideographic space separates words in a CJK transcript exactly as a
  // space does here, and a newline-only backoff tears the token after it.
  const text = `${'\u4e00'.repeat(7000)}\u3000${'\u4e8c'.repeat(2000)}`
  const chunks = [...searchMessageRows([{ role: 'user', text, timestamp: null }])].map(
    (row) => row.text
  )

  expect(chunks[0]).toBe(`${'\u4e00'.repeat(7000)}\u3000`)
  expect(chunks.join('')).toBe(text)
})

it('still chunks a message that holds no whitespace at all', () => {
  // A 20,000-character token is not a word, so the target itself is the cut and
  // the message is still bounded.
  const chunks = [
    ...searchMessageRows([{ role: 'user', text: 'a'.repeat(20_000), timestamp: null }])
  ]
  expect(chunks.map((row) => row.text.length)).toEqual([8000, 8000, 4000])
})

it('leaves a message that fits as a single row', () => {
  const rows = [...searchMessageRows([{ role: 'user', text: 'short enough', timestamp: null }])]
  expect(rows.map((row) => row.text)).toEqual(['short enough'])
})

it('caps a tool row at its head and never caps the conversation', async () => {
  const index = await openSessionSearchIndexFile('ss-rows-tool-cap')
  try {
    // The reader hands over untruncated text (its own bound is 256 KB per
    // message and a consumer may be handed more); the cap is this module's.
    const output = `pericardium ${'padding '.repeat(140_000)}`
    expect(output.length).toBeGreaterThan(1024 * 1024)

    const toolRows = [...searchMessageRows([{ role: 'tool', text: output, timestamp: null }])]
    expect(toolRows).toHaveLength(1)
    expect(toolRows[0]!.text.length).toBe(3072)
    // The head is what identifies what ran, so it is what survives.
    expect(toolRows[0]!.text.startsWith('pericardium ')).toBe(true)

    // The same text as an assistant turn is conversation, and keeps every byte.
    const assistantRows = [
      ...searchMessageRows([{ role: 'assistant', text: output, timestamp: null }])
    ]
    expect(assistantRows.map((row) => row.text).join('')).toBe(output)
    expect(assistantRows.length).toBeGreaterThan(100)

    for (const row of toolRows) {
      insertSearchMessage(index.db, 1, row)
    }
    expect(
      index.db
        .prepare('SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?')
        .get('pericardium')
    ).toEqual({ n: 1 })
  } finally {
    await index.close()
  }
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
