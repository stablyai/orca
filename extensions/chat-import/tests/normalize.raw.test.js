// tests/normalize.raw.test.js
// Task 7: normalizeChatGPT/normalizeClaude must attach the original raw message
// object as `_raw` on each produced message, so content.js's attachment resolver
// (adapter.attachments(msg._raw)) has something to read before it deletes `_raw`
// prior to INGEST. content.js itself has no module.exports (relies on chrome.*),
// so the resolver wiring in runSync() can't be unit-tested via require() here;
// this test covers the exported, requirable half of the contract: that normalize
// actually produces the `_raw` field the resolver depends on.
import { test, expect } from 'vitest'
import { normalizeChatGPT, normalizeClaude } from '../lib/normalize.js'

test('normalizeChatGPT attaches _raw (original mapping message) to each produced message', () => {
  const userMsg = {
    author: { role: 'user' },
    content: { content_type: 'text', parts: ['hi'] },
    create_time: 1
  }
  const aiMsg = {
    author: { role: 'assistant' },
    content: { content_type: 'text', parts: ['hello'] },
    create_time: 2
  }
  const raw = {
    title: 'T',
    create_time: 0,
    current_node: 'b',
    mapping: {
      a: { message: userMsg, parent: null },
      b: { message: aiMsg, parent: 'a' }
    }
  }
  const conv = normalizeChatGPT(raw, 'cid')
  expect(conv.messages.length).toBe(2)
  expect(conv.messages[0]._raw).toBe(userMsg)
  expect(conv.messages[1]._raw).toBe(aiMsg)
})

test('normalizeClaude attaches _raw (original chat_messages entry) to each produced message', () => {
  const humanMsg = { sender: 'human', text: 'which lib?', created_at: '2025-02-01T00:00:01Z' }
  const aiMsg = {
    sender: 'assistant',
    text: '',
    content: [{ type: 'text', text: 'use zustand' }],
    created_at: '2025-02-01T00:00:02Z'
  }
  const raw = {
    uuid: 'u-1',
    name: 'React state',
    created_at: '2025-02-01T00:00:00Z',
    chat_messages: [humanMsg, aiMsg]
  }
  const conv = normalizeClaude(raw, 'u-1')
  expect(conv.messages.length).toBe(2)
  expect(conv.messages[0]._raw).toBe(humanMsg)
  expect(conv.messages[1]._raw).toBe(aiMsg)
})
