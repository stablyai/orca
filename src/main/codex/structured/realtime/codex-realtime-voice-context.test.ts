import { expect, it } from 'vitest'
import type { CodexAppServerConnection } from '../../app-server/codex-app-server-connection-types'
import {
  codexVoiceInitialItemsFromTimeline,
  readCodexVoiceInitialItems
} from './codex-realtime-voice-context'

it("keeps this chat's requests, answers, voice and unrepeated hand-offs, and nothing else", () => {
  const item = (turnId: string, value: Record<string, unknown>) => ({
    type: 'item',
    turnId,
    item: value
  })
  const spoken = (role: string, text: string) => ({
    type: 'realtime',
    item: { id: `rt-${text}`, realtimeSessionId: 'voice-1', type: 'transcriptSegment', role, text }
  })
  const entries = [
    item('t1', {
      type: 'userMessage',
      id: 'u1',
      content: [{ type: 'text', text: 'Let us compare two caching ideas.' }]
    }),
    item('t1', {
      type: 'agentMessage',
      id: 'a1',
      text: 'Reading the cache module.',
      phase: 'commentary'
    }),
    item('t1', { type: 'commandExecution', id: 'c1', command: 'cat cache.ts' }),
    item('t1', {
      type: 'agentMessage',
      id: 'a2',
      text: 'Write-through keeps reads fresh.',
      phase: 'final_answer'
    }),
    { type: 'turnCompleted', turnId: 't1' },
    spoken('user', 'What about write-back?'),
    spoken('assistant', 'It trades durability for speed.'),
    item('t2', {
      type: 'userMessage',
      id: 'u-dup',
      content: [
        {
          type: 'text',
          text: '<realtime_delegation>\n  <input>What about write-back?</input>\n</realtime_delegation>'
        }
      ]
    }),
    item('t2', {
      type: 'userMessage',
      id: 'u2',
      content: [
        {
          type: 'text',
          text: '<realtime_delegation>\n  <input>Check the eviction code</input>\n</realtime_delegation>'
        }
      ]
    }),
    item('t2', { type: 'agentMessage', id: 'a3', text: 'Eviction is LRU.', phase: null }),
    { type: 'turnCompleted', turnId: 't2' }
  ]

  expect(codexVoiceInitialItemsFromTimeline(entries)).toEqual([
    { role: 'user', text: 'Let us compare two caching ideas.' },
    { role: 'assistant', text: 'Write-through keeps reads fresh.' },
    { role: 'user', text: 'What about write-back?' },
    { role: 'assistant', text: 'It trades durability for speed.' },
    { role: 'user', text: 'Check the eviction code' },
    { role: 'assistant', text: 'Eviction is LRU.' }
  ])
})

it('falls back to the newest turns, oldest first, when Codex cannot list the timeline', async () => {
  const connection = {
    pid: 1,
    closed: false,
    request: async (method: string) => {
      if (method === 'thread/timeline/list') {
        throw new Error('thread/timeline/list is not supported yet')
      }
      return {
        data: [
          {
            id: 't2',
            items: [
              { type: 'userMessage', id: 'u2', content: [{ type: 'text', text: 'And the TTL?' }] },
              { type: 'agentMessage', id: 'a2', text: 'Five minutes.', phase: 'final_answer' }
            ]
          },
          {
            id: 't1',
            items: [
              { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'Cache or not?' }] },
              { type: 'agentMessage', id: 'a1', text: 'Cache it.', phase: 'final_answer' }
            ]
          }
        ]
      }
    },
    notify: () => {},
    respond: () => {},
    respondWithError: () => {},
    close: async () => true
  } satisfies CodexAppServerConnection
  expect(await readCodexVoiceInitialItems(connection, 'thread-1')).toEqual([
    { role: 'user', text: 'Cache or not?' },
    { role: 'assistant', text: 'Cache it.' },
    { role: 'user', text: 'And the TTL?' },
    { role: 'assistant', text: 'Five minutes.' }
  ])
})
