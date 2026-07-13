// tests/normalize.geminipage.test.js
import { test, expect } from 'vitest'
import { parseGeminiListPage, parseGeminiList } from '../lib/normalize.js'

function envelope(inner) {
  return ")]}'\n\n10\n" + JSON.stringify([['wrb.fr', 'MaZiqc', JSON.stringify(inner), null]])
}

test('parseGeminiListPage returns items and nextToken when more pages remain', () => {
  const inner = [
    null,
    'TOKEN_abc',
    [
      ['c_1', 'T1', null],
      ['c_2', 'T2', null]
    ]
  ]
  const page = parseGeminiListPage(envelope(inner))
  expect(page.items).toEqual([
    { externalId: 'c_1', title: 'T1' },
    { externalId: 'c_2', title: 'T2' }
  ])
  expect(page.nextToken).toBe('TOKEN_abc')
})

test('parseGeminiListPage returns null nextToken on the last page (empty inner[1])', () => {
  const inner = [null, '', [['c_9', 'Last', null]]]
  const page = parseGeminiListPage(envelope(inner))
  expect(page.nextToken).toBe(null)
  expect(page.items.length).toBe(1)
})

test('parseGeminiListPage returns empty page on unparseable input', () => {
  expect(parseGeminiListPage('garbage')).toEqual({ items: [], nextToken: null })
})

test('parseGeminiList still returns just the first-page items (back-compat)', () => {
  const inner = [null, 'TOKEN_abc', [['c_1', 'T1', null]]]
  expect(parseGeminiList(envelope(inner))).toEqual([{ externalId: 'c_1', title: 'T1' }])
})
