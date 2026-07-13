// tests/normalize.gemini.test.js
import { test, expect } from 'vitest'
import { parseGeminiList, titleFallback, normalizeGemini } from '../lib/normalize.js'
import { SAMPLE_RAW, EXPECT } from './fixtures/gemini-hNvQHb.sample.js'

test('parseGeminiList reads inner[2] rows of [externalId, title]', () => {
  const inner = [
    null,
    'meta',
    [
      ['c_9c4fb00e8b8bef8f', 'Docker error', null, null],
      ['c_faa57a8d6d639715', 'React state', null, null]
    ]
  ]
  const escaped = JSON.stringify(JSON.stringify(inner))
  const raw = ')]}\'\n\n10\n[["wrb.fr","MaZiqc",' + escaped + ',null]]'
  expect(parseGeminiList(raw)).toEqual([
    { externalId: 'c_9c4fb00e8b8bef8f', title: 'Docker error' },
    { externalId: 'c_faa57a8d6d639715', title: 'React state' }
  ])
})

test('parseGeminiList returns [] on unparseable input', () => {
  expect(parseGeminiList('garbage')).toEqual([])
})

test('titleFallback wraps a title-only conversation as one USER message', () => {
  const out = titleFallback({
    source: 'GEMINI',
    externalId: 'g1',
    title: 'Lonely',
    createdAt: '2025-03-01T00:00:00Z'
  })
  expect(out.messages.length).toBe(1)
  expect(out.messages[0]).toEqual({ role: 'USER', idx: 0, text: 'Lonely', createdAt: null })
  expect(out.source).toBe('GEMINI')
})

test('normalizeGemini extracts chronological user/model turns from hNvQHb', () => {
  const conv = normalizeGemini(SAMPLE_RAW, 'c_1', '제목')
  expect(conv.source).toBe('GEMINI')
  expect(conv.externalId).toBe('c_1')
  expect(conv.title).toBe('제목')
  expect(conv.messages.map((m) => m.role)).toEqual(EXPECT.roles)
  expect(conv.messages.map((m) => m.text)).toEqual(EXPECT.texts)
  expect(conv.messages[0].createdAt).toBe(EXPECT.firstCreatedAt)
})

test('normalizeGemini returns empty messages on unparseable input', () => {
  expect(normalizeGemini('garbage', 'c_x').messages).toEqual([])
})

test('titleFallback with no createdAt yields null (lets desktop apply import-time fallback)', () => {
  const out = titleFallback({ source: 'GEMINI', externalId: 'g1', title: 'T' })
  expect(out.createdAt).toBe(null)
})
