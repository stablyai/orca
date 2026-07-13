import { test, expect } from 'vitest'
import { ensureNonEmpty } from '../lib/normalize.js'

test('ensureNonEmpty passes through non-empty conv', () => {
  const conv = {
    source: 'CHATGPT',
    externalId: 'e',
    title: 't',
    createdAt: '2025-01-01T00:00:00Z',
    messages: [{ role: 'USER', idx: 0, text: 'hi', createdAt: null }]
  }
  expect(ensureNonEmpty(conv)).toBe(conv)
})

test('ensureNonEmpty substitutes titleFallback when messages empty', () => {
  const conv = {
    source: 'GEMINI',
    externalId: 'g1',
    title: 'Lonely',
    createdAt: '2025-03-01T00:00:00Z',
    messages: []
  }
  const out = ensureNonEmpty(conv)
  expect(out.messages.length).toBe(1)
  expect(out.messages[0].text).toBe('Lonely')
  expect(out.externalId).toBe('g1')
})
