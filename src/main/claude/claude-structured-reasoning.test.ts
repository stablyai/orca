import { checkpointJournalRig, closeCheckpointTestJournals } from './claude-checkpoint-test-support'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

function setup() {
  const rows = new Map<string, AgentJournalItemBody>()
  const translator = createClaudeJournalTranslator({
    sink: {
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

afterEach(closeCheckpointTestJournals)

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

it('distinguishes scoped restart, all-open idle and ordinary acquisition end in saved output', async () => {
  const r = await checkpointJournalRig()
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  const stream = (parent: string | null, event: Record<string, unknown>) =>
    r.message({ type: 'stream_event', parent_tool_use_id: parent, event })
  for (const [parent, id] of [
    [null, 'root'],
    ['child-tool', 'child']
  ] as const) {
    stream(parent, { type: 'message_start', message: { id } })
    stream(parent, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: id }
    })
  }
  r.translator.flush()
  await r.deferred.drained()
  const rootKey = 'claude:claude-session:block%3Aroot%3A0'
  const childKey = 'claude:claude-session:block%3Achild%3A0'
  const firstChild = r.journal.item(childKey)
  if (!firstChild) {
    throw new Error('child reasoning must be saved before restart')
  }
  vi.setSystemTime(2000)
  stream(null, { type: 'message_start', message: { id: 'root-next' } })
  await r.deferred.drained()
  expect(r.journal.itemBody(rootKey)).toMatchObject({
    blocks: [{ type: 'text', text: 'root' }],
    state: 'completed',
    completedAt: 2000
  })
  expect(r.journal.itemBody(childKey)).toMatchObject({ state: 'running' })
  stream('child-tool', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: ' tail' }
  })
  r.translator.flush()
  await r.deferred.drained()
  expect(r.journal.item(childKey)).toMatchObject({
    sequence: firstChild.sequence,
    observedAt: firstChild.observedAt,
    turnScope: firstChild.turnScope,
    body: { state: 'running', blocks: [{ type: 'text', text: 'child tail' }] }
  })
  vi.setSystemTime(3000)
  r.message({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
  await r.deferred.drained()
  expect(r.journal.itemBody(childKey)).toMatchObject({
    blocks: [{ type: 'text', text: 'child tail' }],
    state: 'completed',
    completedAt: 3000
  })
  vi.setSystemTime(4000)
  stream(null, { type: 'message_start', message: { id: 'last' } })
  for (const [index, type, field, text] of [
    [0, 'text_delta', 'text', 'answer'],
    [1, 'thinking_delta', 'thinking', 'thought']
  ] as const) {
    stream(null, { type: 'content_block_delta', index, delta: { type, [field]: text } })
  }
  r.translator.handle({ type: 'ended', sessionId: 'recovery', observedAt: 4000, reason: 'exit' })
  await r.deferred.drained()
  expect(r.journal.itemBody('claude:claude-session:block%3Alast%3A0')).toMatchObject({
    blocks: [{ type: 'text', text: 'answer' }]
  })
  expect(r.journal.itemBody('claude:claude-session:block%3Alast%3A1')).toMatchObject({
    blocks: [{ type: 'text', text: 'thought' }],
    state: 'completed',
    completedAt: 4000
  })
  r.translator.dispose()
  expect(r.translator.pendingStreamedBlocks).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  const saved = r.journal.snapshot().items
  await r.journal.close()
  const reopened = await r.reopen()
  expect(reopened.snapshot().items).toEqual(saved)
})

it('preserves first meaningful chronology, disclosure, exact prefix and original envelope through every reader', async () => {
  const { readStructuredAgentSessionHistoryResult } =
    await import('../native-chat/agent-session-wire/structured-agent-session-history-result')
  const { EMPTY_STRUCTURED_AGENT_SESSION, reduceStructuredAgentSession } =
    await import('../../shared/structured-agent-session-reducer')
  const { projectStructuredItemsToNativeChat } =
    await import('../../shared/structured-agent-session-projection')
  const { selectNativeChatLiveReasoning } =
    await import('../../shared/native-chat/transcript/native-chat-reasoning-row')
  for (const scenario of ['blank', 'suffix', 'tool', 'next-blank']) {
    const r = await checkpointJournalRig()
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    r.stream({ type: 'message_start', message: { id: scenario } })
    const delta = (index: number, thinking: string) =>
      r.stream({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } })
    const read = () => {
      const result = readStructuredAgentSessionHistoryResult({
        journal: r.journal,
        record: null,
        request: {
          sessionId: 'recovery',
          direction: 'after',
          cursor: { epoch: r.journal.epoch, sequence: 0 }
        }
      })
      const history = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
        type: 'history-page',
        page: result.page
      })
      const live = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
        type: 'event',
        event: { type: 'snapshot', sessionId: 'recovery', fence: 1, page: result.page }
      })
      expect(history.items).toEqual(r.journal.publicRead().snapshot.items)
      expect(live.items).toEqual(history.items)
      const messages = projectStructuredItemsToNativeChat(history.items)
      return {
        messages,
        disclosure: selectNativeChatLiveReasoning(messages, () => true)?.markdown ?? null
      }
    }
    delta(0, ' \n ')
    r.translator.flush()
    await r.deferred.drained()
    expect(read().messages.filter((m) => m.role === 'reasoning')).toHaveLength(0)
    if (scenario === 'tool') {
      r.message({
        type: 'assistant',
        message: {
          id: scenario,
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'pwd' } }]
        }
      })
    }
    if (scenario !== 'blank') {
      vi.setSystemTime(2000)
      delta(0, 'Meaningful')
      r.translator.flush()
      await r.deferred.drained()
      const key = `claude:claude-session:block%3A${scenario}%3A0`
      expect(r.journal.item(key)).toMatchObject({
        observedAt: 1000,
        body: { blocks: [{ type: 'text', text: ' \n Meaningful' }] }
      })
      expect(read().disclosure).toBe(' \n Meaningful')
      if (scenario === 'tool') {
        const rows = r.journal
          .snapshot()
          .items.filter(
            (item) =>
              item.body.kind === 'tool-call' ||
              (item.body.kind === 'message' && item.body.role === 'reasoning')
          )
        expect(rows.map((item) => item.body.kind)).toEqual(['tool-call', 'message'])
      }
      if (scenario === 'next-blank') {
        delta(1, ' \n ')
        r.translator.flush()
        await r.deferred.drained()
        expect(read().disclosure).toBe(' \n Meaningful')
      }
    }
    r.message({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    await r.deferred.drained()
    const saved = r.journal.snapshot().items
    r.translator.dispose()
    await r.journal.close()
    const reopened = await r.reopen()
    expect(reopened.snapshot().items).toEqual(saved)
    vi.useRealTimers()
  }
})
