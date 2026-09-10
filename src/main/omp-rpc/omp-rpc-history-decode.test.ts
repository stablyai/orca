import { describe, expect, it } from 'vitest'
import type { OmpRpcHistoryMessage } from '../../shared/omp-rpc-protocol'
import { decodeOmpTranscriptLine } from '../native-chat/transcript-line-decoders-omp'
import { decodeOmpRpcHistoryMessages } from './omp-rpc-history-decode'

function historyMessage(overrides: Record<string, unknown>): OmpRpcHistoryMessage {
  return { timestamp: 1_700_000_000_000, ...overrides }
}

describe('decodeOmpRpcHistoryMessages', () => {
  it('decodes a user turn as an rpc-sourced message', () => {
    // get_messages_page returns bare AgentMessages (rpc-messages.ts RpcMessagesPage),
    // never the on-disk SessionMessageEntry envelope, so there is no wire id to carry.
    const decoded = decodeOmpRpcHistoryMessages([
      historyMessage({ role: 'user', content: [{ type: 'text', text: 'hello' }] })
    ])

    expect(decoded).toEqual([
      {
        id: 'omp-rpc-history-0',
        role: 'user',
        blocks: [{ type: 'text', text: 'hello' }],
        timestamp: 1_700_000_000_000,
        originTimestamp: 1_700_000_000_000,
        source: 'rpc'
      }
    ])
  })

  it('recovers the same message clock the transcript decoder does', () => {
    // The renderable clocks of the two sources disagree by design: the on-disk
    // envelope is stamped when the line is persisted, seconds after the message
    // it wraps, while a wire record carries only the message's own clock.
    // `originTimestamp` is the one reading both sides share, and the hydration
    // merge has no record identity without it — every turn would either
    // duplicate on reconnect or be retired as a coincidental content match
    // (native-chat-rpc-history-merge.ts).
    const message = historyMessage({ role: 'user', content: [{ type: 'text', text: 'hello' }] })
    const [fromWire] = decodeOmpRpcHistoryMessages([message])
    const fromDisk = decodeOmpTranscriptLine(
      JSON.stringify({
        type: 'message',
        id: 'rec-1',
        parentId: null,
        timestamp: '2026-07-16T00:27:02.222Z',
        message
      }),
      'rec-1'
    )
    if (fromDisk === null || Array.isArray(fromDisk)) {
      throw new Error('expected a single decoded transcript message')
    }

    expect(fromWire?.originTimestamp).toBe(1_700_000_000_000)
    expect(fromDisk.originTimestamp).toBe(1_700_000_000_000)
    // The renderable clocks genuinely differ, which is why the field exists.
    expect(fromDisk.timestamp).not.toBe(fromWire?.timestamp)
  })

  it('splits reasoning ahead of the reply, matching the transcript decoder', () => {
    const decoded = decodeOmpRpcHistoryMessages([
      historyMessage({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'weighing it' },
          { type: 'text', text: 'the answer' }
        ]
      })
    ])

    expect(decoded.map((message) => [message.id, message.role])).toEqual([
      ['omp-rpc-history-0:reasoning', 'reasoning'],
      ['omp-rpc-history-0', 'assistant']
    ])
    expect(decoded.every((message) => message.source === 'rpc')).toBe(true)
  })

  it('keeps positional ids distinct so a split turn never collides with its neighbour', () => {
    const decoded = decodeOmpRpcHistoryMessages([
      historyMessage({ role: 'user', content: [{ type: 'text', text: 'a' }] }),
      historyMessage({ role: 'assistant', content: [{ type: 'text', text: 'b' }] })
    ])

    expect(decoded.map((message) => message.id)).toEqual(['omp-rpc-history-0', 'omp-rpc-history-1'])
  })

  it('decodes a toolResult turn through the shared decoder', () => {
    const decoded = decodeOmpRpcHistoryMessages([
      historyMessage({
        role: 'toolResult',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: 'ran' }],
        isError: false
      })
    ])

    expect(decoded).toEqual([
      {
        id: 'omp-rpc-history-0',
        role: 'tool',
        blocks: [{ type: 'tool-result', output: 'ran', toolCallId: 'call-1' }],
        timestamp: 1_700_000_000_000,
        originTimestamp: 1_700_000_000_000,
        source: 'rpc'
      }
    ])
  })

  it('drops records the transcript decoder itself refuses, without shifting later ids', () => {
    // A hidden extension turn (display !== true) renders nowhere in OMP either;
    // dropping it must not renumber the messages that follow, or a second
    // hydration would produce different ids for the same turns.
    const decoded = decodeOmpRpcHistoryMessages([
      historyMessage({ role: 'custom', content: [{ type: 'text', text: 'hidden' }] }),
      historyMessage({ role: 'user', content: [{ type: 'text', text: 'visible' }] })
    ])

    expect(decoded.map((message) => message.id)).toEqual(['omp-rpc-history-1'])
  })

  it('yields a null timestamp when the wire message carries an unusable one', () => {
    const decoded = decodeOmpRpcHistoryMessages([
      { role: 'user', content: [{ type: 'text', text: 'no clock' }], timestamp: 0 }
    ])

    expect(decoded[0]?.timestamp).toBeNull()
  })
})
