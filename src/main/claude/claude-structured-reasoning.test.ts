import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

function setup() {
  const rows = new Map<string, AgentJournalItemBody>()
  const translator = createClaudeJournalTranslator({
    sink: {
      // Output also opens its turn; these tests read only the content rows.
      appendItem: (identity, body) => {
        if (body.kind !== 'turn') {
          rows.set(agentJournalItemKey(identity), body)
        }
      },
      appendTombstone: vi.fn(),
      publish: vi.fn()
    }
  })
  const frame = (message: Record<string, unknown>, observedAt?: number): void =>
    translator.handle({
      type: 'message',
      sessionId: 'orca-session',
      ...(observedAt === undefined ? {} : { observedAt }),
      message: {
        session_id: 'session',
        parent_tool_use_id: null,
        ...message
      }
    })
  const stream = (uuid: string, event: Record<string, unknown>, observedAt?: number): void =>
    frame({ type: 'stream_event', uuid, event }, observedAt)
  const final = (uuid: string, content: unknown[], observedAt?: number): void =>
    frame(
      {
        type: 'assistant',
        uuid,
        message: { id: 'message-1', role: 'assistant', content }
      },
      observedAt
    )
  return { rows, translator, frame, stream, final }
}

function reasoning(text: string, lifecycle: Record<string, unknown>): AgentJournalItemBody {
  return {
    kind: 'message',
    role: 'reasoning',
    blocks: [{ type: 'text', text }],
    ...lifecycle
  }
}

afterEach(() => vi.useRealTimers())

describe('structured Claude reasoning', () => {
  it.each(['', ' ', '\n\t'])('omits blank final thinking %j', (thinking) => {
    const { rows, final, translator } = setup()
    final('final-only', [{ type: 'thinking', thinking }])
    expect([...rows.values()]).toEqual([])
    translator.dispose()
  })

  it('writes final-only thinking closed, with no span it never saw', () => {
    const { rows, final, translator } = setup()
    final('final-only', [{ type: 'thinking', thinking: 'Inspecting the request' }], 5_000)
    expect([...rows.values()]).toEqual([
      reasoning('Inspecting the request', { state: 'completed' })
    ])
    translator.dispose()
  })

  it('streams a running row and closes that same row on its final frame', () => {
    vi.useFakeTimers()
    const { rows, stream, final, translator } = setup()
    stream('start', { type: 'message_start', message: { id: 'message-1' } }, 1_000)
    stream(
      'thinking-start',
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      1_000
    )
    stream(
      'delta-1',
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Inspecting ' }
      },
      3_000
    )
    translator.flush()
    const firstKey = [...rows.keys()][0]
    expect(rows.get(firstKey!)).toEqual(reasoning('Inspecting ', { state: 'running' }))
    stream(
      'delta-2',
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'the request' }
      },
      4_000
    )
    translator.flush()
    expect([...rows.keys()]).toEqual([firstKey])
    final('thinking-final', [{ type: 'thinking', thinking: 'Inspecting the request' }], 9_000)
    expect([...rows.keys()]).toEqual([firstKey])
    expect(rows.get(firstKey!)).toEqual(
      reasoning('Inspecting the request', { state: 'completed', completedAt: 9_000 })
    )

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
    expect([...rows.values()].map((body) => body.kind === 'message' && body.role)).toEqual([
      'reasoning',
      'assistant'
    ])
    expect(translator.pendingStreamedBlocks).toBe(0)
    translator.dispose()
  })

  it('closes a streamed row with its streamed text when the final frame carries none', () => {
    vi.useFakeTimers()
    const { rows, stream, final, translator } = setup()
    stream(
      'delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Summary' }
      },
      1_000
    )
    final('thinking-final', [{ type: 'thinking', thinking: '', signature: 'sig' }], 2_000)
    expect([...rows.values()]).toEqual([
      reasoning('Summary', { state: 'completed', completedAt: 2_000 })
    ])
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

  it('writes streamed thinking into the turn its first delta opened', () => {
    vi.useFakeTimers()
    const scopes: unknown[] = []
    const translator = createClaudeJournalTranslator({
      sink: {
        appendItem: (_identity, body, options) => {
          if (body.kind === 'message' && body.role === 'reasoning') {
            scopes.push(options.turnScope)
          }
        },
        appendTombstone: vi.fn(),
        publish: vi.fn()
      }
    })
    translator.handle({
      type: 'message',
      sessionId: 'orca-session',
      message: {
        type: 'stream_event',
        session_id: 'session',
        parent_tool_use_id: null,
        uuid: 'delta',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Considering' }
        }
      }
    })
    translator.flush()
    expect(scopes).toEqual([{ kind: 'turn', turnItemId: expect.stringContaining('turn') }])
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
