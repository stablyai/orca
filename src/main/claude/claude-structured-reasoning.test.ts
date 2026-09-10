import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

function setup() {
  const rows = new Map<string, AgentJournalItemBody>()
  const translator = createClaudeJournalTranslator({
    sink: {
      appendItem: (identity, body) => rows.set(agentJournalItemKey(identity), body),
      appendTombstone: vi.fn(),
      publish: vi.fn()
    }
  })
  const frame = (message: Record<string, unknown>): void =>
    translator.handle({
      type: 'message',
      sessionId: 'orca-session',
      message: {
        session_id: 'session',
        parent_tool_use_id: null,
        ...message
      }
    })
  const stream = (uuid: string, event: Record<string, unknown>): void =>
    frame({ type: 'stream_event', uuid, event })
  const final = (uuid: string, content: unknown[]): void =>
    frame({
      type: 'assistant',
      uuid,
      message: { id: 'message-1', role: 'assistant', content }
    })
  return { rows, translator, frame, stream, final }
}

afterEach(() => vi.useRealTimers())

describe('structured Claude reasoning', () => {
  it.each(['', ' ', '\n\t'])('omits blank final thinking %j', (thinking) => {
    const { rows, final, translator } = setup()
    final('final-only', [{ type: 'thinking', thinking }])
    expect([...rows.values()]).toEqual([])
    translator.dispose()
  })

  it('emits final-only thinking with readable reasoning text', () => {
    const { rows, final, translator } = setup()
    final('final-only', [{ type: 'thinking', thinking: 'Inspecting the request' }])
    expect([...rows.values()]).toEqual([
      {
        kind: 'message',
        role: 'reasoning',
        blocks: [{ type: 'text', text: 'Inspecting the request' }]
      }
    ])
    translator.dispose()
  })

  it('keeps reasoning identity through deltas and final frames, apart from assistant prose', () => {
    vi.useFakeTimers()
    const { rows, stream, final, translator } = setup()
    stream('start', { type: 'message_start', message: { id: 'message-1' } })
    stream('thinking-start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' }
    })
    stream('delta-1', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'Inspecting ' }
    })
    translator.flush()
    const firstKey = [...rows.keys()][0]
    expect(firstKey).toBeDefined()
    stream('delta-2', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'the request' }
    })
    translator.flush()
    expect([...rows.keys()]).toEqual([firstKey])
    final('thinking-final', [{ type: 'thinking', thinking: 'Inspecting the request' }])
    expect([...rows.keys()]).toEqual([firstKey])
    expect(rows.get(firstKey!)).toEqual({
      kind: 'message',
      role: 'reasoning',
      blocks: [{ type: 'text', text: 'Inspecting the request' }]
    })

    stream('text-start', {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' }
    })
    stream('text-delta', {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'Here is the answer' }
    })
    translator.flush()
    final('text-final', [{ type: 'text', text: 'Here is the answer' }])
    expect(rows.size).toBe(2)
    expect([...rows.values()].map((body) => body.kind === 'message' && body.role)).toEqual([
      'reasoning',
      'assistant'
    ])
    expect(translator.pendingStreamedBlocks).toBe(0)
    translator.dispose()
  })

  it('flushes interrupted thinking and releases its checkpoint state', () => {
    vi.useFakeTimers()
    const { rows, stream, frame, translator } = setup()
    stream('delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'Unfinished thought' }
    })
    frame({ type: 'result', subtype: 'success', uuid: 'result' })
    expect([...rows.values()]).toContainEqual({
      kind: 'message',
      role: 'reasoning',
      blocks: [{ type: 'text', text: 'Unfinished thought' }]
    })
    expect(translator.pendingStreamedBlocks).toBe(0)
    translator.dispose()
  })

  it('reconciles an empty final block before the next thinking block', () => {
    const { rows, stream, final, translator } = setup()
    stream('empty-start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' }
    })
    final('empty-final', [{ type: 'thinking', thinking: '' }])
    stream('next-start', {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'thinking', thinking: 'Next thought' }
    })
    translator.flush()
    const key = [...rows.keys()][0]
    final('next-final', [{ type: 'thinking', thinking: 'Next thought' }])
    expect([...rows.keys()]).toEqual([key])
    expect(translator.pendingStreamedBlocks).toBe(0)
    translator.dispose()
  })

  it('omits whitespace-only thinking deltas', () => {
    vi.useFakeTimers()
    const { rows, stream, translator } = setup()
    stream('delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: ' \n ' }
    })
    translator.flush()
    expect(rows.size).toBe(0)
    translator.dispose()
  })
})
