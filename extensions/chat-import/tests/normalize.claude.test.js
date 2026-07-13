// tests/normalize.claude.test.js
import { test, expect } from 'vitest'
import { normalizeClaude } from '../lib/normalize.js'

const RAW = {
  uuid: 'u-1',
  name: 'React state',
  created_at: '2025-02-01T00:00:00Z',
  chat_messages: [
    { sender: 'human', text: 'which lib?', created_at: '2025-02-01T00:00:01Z' },
    {
      sender: 'assistant',
      text: '',
      content: [{ type: 'text', text: 'use zustand' }],
      created_at: '2025-02-01T00:00:02Z'
    }
  ]
}

test('normalizeClaude maps sender + falls back to content text', () => {
  const out = normalizeClaude(RAW, 'u-1')
  expect(out.source).toBe('CLAUDE')
  expect(out.title).toBe('React state')
  expect(out.createdAt).toBe('2025-02-01T00:00:00Z')
  expect(out.messages.map((m) => [m.role, m.idx, m.text])).toEqual([
    ['USER', 0, 'which lib?'],
    ['AI', 1, 'use zustand']
  ])
})

test('normalizeClaude splits thinking/text into blocks (rendering_mode=messages)', () => {
  const raw = {
    uuid: 'u-2',
    name: 'T',
    created_at: '2025-02-01T00:00:00Z',
    chat_messages: [
      {
        sender: 'assistant',
        text: 'flattened ignored',
        content: [
          { type: 'thinking', thinking: 'let me think' },
          { type: 'text', text: 'here is the answer' },
          { type: 'thinking', thinking: 'reconsider' },
          { type: 'text', text: 'final answer' }
        ],
        created_at: '2025-02-01T00:00:02Z'
      }
    ]
  }
  const ai = normalizeClaude(raw, 'u-2').messages[0]
  expect(ai.blocks).toEqual([
    { kind: 'thinking', text: 'let me think' },
    { kind: 'text', text: 'here is the answer' },
    { kind: 'thinking', text: 'reconsider' },
    { kind: 'text', text: 'final answer' }
  ])
  // text 필드는 thinking 제외, 답변만
  expect(ai.text).toBe('here is the answer\n\nfinal answer')
})

test('normalizeClaude drops the unsupported-block placeholder in text blocks', () => {
  const raw = {
    uuid: 'u-3',
    name: 'T',
    created_at: '2025-02-01T00:00:00Z',
    chat_messages: [
      {
        sender: 'assistant',
        content: [
          {
            type: 'text',
            text: 'real\n```\nThis block is not supported on your current device yet.\n```\nmore'
          }
        ],
        created_at: '2025-02-01T00:00:02Z'
      }
    ]
  }
  const ai = normalizeClaude(raw, 'u-3').messages[0]
  expect(ai.blocks[0].text).toBe('real\nmore')
})
