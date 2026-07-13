// tests/normalize.chatgpt.test.js
import { test, expect } from 'vitest'
import { stripWidgets, normalizeChatGPT } from '../lib/normalize.js'

const S = ''

const RAW = {
  title: 'Docker error',
  create_time: 1735689600, // 2025-01-01T00:00:00Z
  current_node: 'n3',
  mapping: {
    root: { id: 'root', message: null, parent: null, children: ['n1'] },
    n1: {
      id: 'n1',
      parent: 'root',
      children: ['n2'],
      message: {
        author: { role: 'user' },
        content: { content_type: 'text', parts: ['hi'] },
        create_time: 1735689601
      }
    },
    n2: {
      id: 'n2',
      parent: 'n1',
      children: ['n3'],
      message: {
        author: { role: 'assistant' },
        content: { content_type: 'text', parts: ['hello'] },
        create_time: 1735689602
      }
    },
    n3: {
      id: 'n3',
      parent: 'n2',
      children: [],
      message: {
        author: { role: 'system' },
        content: { content_type: 'text', parts: ['ignore me'] },
        create_time: 1735689603
      }
    }
  }
}

test('normalizeChatGPT reconstructs ordered USER/AI messages, drops system', () => {
  const out = normalizeChatGPT(RAW, 'ext-1')
  expect(out.source).toBe('CHATGPT')
  expect(out.externalId).toBe('ext-1')
  expect(out.title).toBe('Docker error')
  expect(out.createdAt).toBe('2025-01-01T00:00:00.000Z')
  expect(out.messages.map((m) => [m.role, m.idx, m.text])).toEqual([
    ['USER', 0, 'hi'],
    ['AI', 1, 'hello']
  ])
})

test('stripWidgets removes PUA-delimited widget directive and its json payload', () => {
  const s = 'before ' + S + 'image_group' + S + '{"query":["a","b"]} after'
  expect(stripWidgets(s)).toBe('before  after')
})

test('stripWidgets leaves normal text and snake_case braces untouched (no PUA)', () => {
  expect(stripWidgets('cost {x} won')).toBe('cost {x} won')
  expect(stripWidgets('my_dict{1:2}')).toBe('my_dict{1:2}')
  expect(stripWidgets('user_config{"a":1}')).toBe('user_config{"a":1}')
})

test('stripWidgets removes nested json payload', () => {
  expect(stripWidgets(S + 'w' + S + '{"a":{"b":1}} tail')).toBe(' tail')
})

test('normalizeChatGPT keeps only text content_type and strips widgets', () => {
  const raw = {
    title: 'T',
    create_time: 0,
    current_node: 'b',
    mapping: {
      a: {
        message: {
          author: { role: 'user' },
          content: { content_type: 'text', parts: ['hi'] },
          create_time: 1
        },
        parent: null
      },
      b: {
        message: {
          author: { role: 'assistant' },
          content: {
            content_type: 'text',
            parts: ['ok ' + S + 'image_group' + S + '{"query":["x"]}']
          },
          create_time: 2
        },
        parent: 'a'
      }
    }
  }
  const conv = normalizeChatGPT(raw, 'cid')
  expect(conv.messages.map((m) => m.text)).toEqual(['hi', 'ok'])
})
