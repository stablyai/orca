import { expect, it } from 'vitest'

import { insertSearchMessage, searchMessageRows } from './session-search-message-rows'
import { openSessionSearchIndexFile } from './session-search-index-test-fixture'

it.each(['/repo/pericardium.ts', 'PROJ-12345', 'C++', 'cafe\u0301ine'])(
  'preserves the exact FTS token %s at a chunk boundary',
  async (token) => {
    const index = await openSessionSearchIndexFile('ss-rows-tokenchars')
    try {
      const text = ' '.repeat(7998) + token
      const chunks = [...searchMessageRows([{ role: 'user', text, timestamp: null }])]
      expect(chunks.map((row) => row.text).join('')).toBe(text)
      for (const row of chunks) {
        insertSearchMessage(index.db, 1, row)
      }
      expect(
        index.db
          .prepare('SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?')
          .get(`"${token}"`)
      ).toEqual({ n: 1 })
    } finally {
      await index.close()
    }
  }
)

it.each(['\u0305', '\u030d', '\u0332'])(
  'cuts at a combining mark unicode61 treats as a separator: %s',
  async (mark) => {
    const index = await openSessionSearchIndexFile('ss-rows-unicode-separator')
    try {
      const text = `${'x'.repeat(7997)}${mark}pericardium`
      for (const row of searchMessageRows([{ role: 'user', text, timestamp: null }])) {
        insertSearchMessage(index.db, 1, row)
      }
      expect(
        index.db
          .prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'pericardium'")
          .get()
      ).toEqual({ n: 1 })
    } finally {
      await index.close()
    }
  }
)

it('cuts at punctuation when the window holds no whitespace at all', async () => {
  const index = await openSessionSearchIndexFile('ss-rows-minified')
  try {
    // Put the limit inside a JSON value with punctuation but no whitespace available as boundaries.
    const text = `{"pad":"${'x'.repeat(7976)}","note":"pericardium"}`
    expect(JSON.parse(text)).toEqual({ pad: 'x'.repeat(7976), note: 'pericardium' })
    expect(text.slice(7994, 8005)).toBe('pericardium')
    expect(/\s/.test(text)).toBe(false)

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

it('drops tool output and preserves the full conversation', () => {
  const output = `pericardium ${'padding '.repeat(140_000)}`
  expect([...searchMessageRows([{ role: 'tool', text: output, timestamp: null }])]).toEqual([])
  const rows = [...searchMessageRows([{ role: 'assistant', text: output, timestamp: null }])]
  expect(rows.map((row) => row.text).join('')).toBe(output)
})
