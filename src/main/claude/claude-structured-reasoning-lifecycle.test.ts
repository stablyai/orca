// Every way a streamed Claude reasoning row ends when its final frame never comes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionAppendOptions } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'

type Write = {
  key: string
  body: AgentJournalItemBody
  options: StructuredAgentSessionAppendOptions
}

function setup() {
  const writes: Write[] = []
  const translator = createClaudeJournalTranslator({
    sink: {
      appendItem: (identity, body, options) =>
        writes.push({ key: agentJournalItemKey(identity), body, options }),
      appendTombstone: vi.fn(),
      publish: vi.fn()
    }
  })
  const message = (
    frame: Record<string, unknown>,
    observedAt: number,
    startsTurn = false
  ): ClaudeStructuredSessionEvent => ({
    type: 'message',
    sessionId: 'orca-session',
    observedAt,
    ...(startsTurn ? { startsTurn: true } : {}),
    message: { session_id: 'claude-session', parent_tool_use_id: null, ...frame }
  })
  const thinkingDelta = (uuid: string, thinking: string, observedAt: number, index = 0): void =>
    translator.handle(
      message(
        {
          type: 'stream_event',
          uuid,
          event: { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } }
        },
        observedAt
      )
    )
  const reasoningWrites = () =>
    writes.filter((write) => write.body.kind === 'message' && write.body.role === 'reasoning')
  const lastReasoning = () => reasoningWrites().at(-1)
  return { writes, translator, message, thinkingDelta, reasoningWrites, lastReasoning }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('a streamed reasoning row the provider never finishes', () => {
  it('ends when the turn settles on its result', () => {
    const { translator, message, thinkingDelta, lastReasoning } = setup()
    thinkingDelta('delta', 'Unfinished thought', 1_000)
    translator.handle(
      message({ type: 'result', subtype: 'success', uuid: 'result', is_error: false }, 4_000)
    )
    expect(lastReasoning()?.body).toMatchObject({
      blocks: [{ type: 'text', text: 'Unfinished thought' }],
      state: 'completed',
      completedAt: 4_000
    })
    // The end must survive backpressure: nothing later would write it.
    expect(lastReasoning()?.options.lifecycle).toBe(true)
    expect(translator.pendingStreamedBlocks).toBe(0)
  })

  it('ends when the CLI reports the session idle', () => {
    const { translator, message, thinkingDelta, lastReasoning } = setup()
    thinkingDelta('delta', 'Unfinished thought', 1_000)
    translator.handle(
      message(
        { type: 'system', subtype: 'session_state_changed', state: 'idle', uuid: 'idle' },
        6_000
      )
    )
    expect(lastReasoning()?.body).toMatchObject({ state: 'completed', completedAt: 6_000 })
  })

  it('ends when the child exits', () => {
    const { translator, thinkingDelta, lastReasoning } = setup()
    thinkingDelta('delta', 'Unfinished thought', 1_000)
    translator.handle({
      type: 'ended',
      sessionId: 'orca-session',
      reason: 'exit',
      observedAt: 7_000
    })
    expect(lastReasoning()?.body).toMatchObject({ state: 'completed', completedAt: 7_000 })
  })

  it('ends when a new send supersedes its turn', () => {
    const { translator, message, thinkingDelta, lastReasoning } = setup()
    thinkingDelta('delta', 'Unfinished thought', 1_000)
    translator.handle(
      message(
        {
          type: 'user',
          uuid: 'user-2',
          message: { role: 'user', content: [{ type: 'text', text: 'next' }] }
        },
        8_000,
        true
      )
    )
    expect(lastReasoning()?.body).toMatchObject({ state: 'completed', completedAt: 8_000 })
  })

  it('ends when its stream starts a new message instead', () => {
    const { translator, message, thinkingDelta, reasoningWrites } = setup()
    thinkingDelta('delta', 'Abandoned attempt', 1_000)
    translator.flush()
    const abandoned = reasoningWrites()[0]?.key
    translator.handle(
      message(
        {
          type: 'stream_event',
          uuid: 'retry',
          event: { type: 'message_start', message: { id: 'm-2' } }
        },
        9_000
      )
    )
    const ends = reasoningWrites().filter((write) => write.key === abandoned)
    expect(ends.at(-1)?.body).toMatchObject({
      blocks: [{ type: 'text', text: 'Abandoned attempt' }],
      state: 'completed',
      completedAt: 9_000
    })
    expect(translator.pendingStreamedBlocks).toBe(0)
  })

  it('writes no end for a block that never had text', () => {
    const { translator, message, thinkingDelta, reasoningWrites } = setup()
    thinkingDelta('delta', '', 1_000)
    translator.handle(
      message({ type: 'result', subtype: 'success', uuid: 'result', is_error: false }, 4_000)
    )
    expect(reasoningWrites()).toEqual([])
  })

  it('is not rewritten by the token tally Claude sends after every thinking delta', () => {
    const { translator, message, thinkingDelta, reasoningWrites } = setup()
    for (let index = 0; index < 20; index += 1) {
      thinkingDelta(`delta-${index}`, 'more words ', 1_000 + index)
      translator.handle(
        message(
          {
            type: 'system',
            subtype: 'thinking_tokens',
            estimated_tokens: index,
            estimated_tokens_delta: 1,
            uuid: `tokens-${index}`
          },
          1_000 + index
        )
      )
    }
    // Text reaches the row on the coalescer's cadence, not once per tally.
    expect(reasoningWrites()).toEqual([])
    vi.advanceTimersByTime(100)
    expect(reasoningWrites()).toHaveLength(1)
  })

  // Timings of the first block in a captured 2.1.280 session with summarized display.
  it('spans from the block start to its final frame, though text arrives seconds later', () => {
    const { translator, message, thinkingDelta, reasoningWrites } = setup()
    const stream = (uuid: string, event: Record<string, unknown>, observedAt: number): void =>
      translator.handle(message({ type: 'stream_event', uuid, event }, observedAt))
    stream('start', { type: 'message_start', message: { id: 'm-1' } }, 3_400)
    stream(
      'block',
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      3_510
    )
    thinkingDelta('delta', 'Planning the module', 8_085)
    translator.handle(
      message(
        {
          type: 'assistant',
          uuid: 'final',
          message: {
            id: 'm-1',
            role: 'assistant',
            content: [{ type: 'thinking', thinking: 'Planning the module', signature: 's' }]
          }
        },
        8_160
      )
    )
    const writes = reasoningWrites()
    expect(writes.length).toBeGreaterThan(0)
    // Every write names the block's start, so whichever creates the row starts it there.
    expect(writes.every((write) => write.options.observedAt === 3_510)).toBe(true)
    expect(writes.at(-1)?.body).toMatchObject({ state: 'completed', completedAt: 8_160 })
  })

  it('writes no row for a stream keep-alive, so nothing lands above the open block', () => {
    const { translator, message, thinkingDelta, writes } = setup()
    thinkingDelta('delta', 'Planning', 1_000)
    translator.handle(
      message({ type: 'stream_event', uuid: 'ping', event: { type: 'ping' } }, 1_010)
    )
    vi.advanceTimersByTime(100)
    expect(writes.filter((write) => write.body.kind === 'status')).toEqual([])
    expect(writes.map((write) => write.body.kind)).toEqual(['turn', 'message'])
  })
})
