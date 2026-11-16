import { describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { createClaudeJournalTranslator } from './journal/claude-structured-journal-translation'
import type { StructuredAgentSessionEventSink } from '../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import {
  PROVIDER_SESSION_ID,
  USER_MESSAGE,
  adapterFor,
  fakeClaude,
  identityFor
} from './claude-structured-session-test-support'

function journalSink() {
  const items: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body) => items.push({ identity, body }),
    appendTombstone: () => {},
    publish: () => {}
  }
  return { sink, items }
}

const root = { session_id: PROVIDER_SESSION_ID, parent_tool_use_id: null }

async function steeredDuringSubagent() {
  // The steer's echo arrives after its interrupt, so the fake does not echo it on send.
  const claude = fakeClaude({ replayUuids: ['turn-1', null] })
  const adapter = adapterFor(claude, {})
  const journal = journalSink()
  await adapter.acquire({
    identity: identityFor(),
    fence: 7,
    spawnToken: 'spawn-9',
    events: journal.sink
  })
  await adapter.dispatch({
    sessionId: 'session-1',
    clientMessageId: 'client-1',
    body: USER_MESSAGE,
    fence: 7
  })
  const connection = claude.connections[0]!
  const emit = (message: Record<string, unknown>) => connection.handlers.onMessage?.(message)
  emit({
    ...root,
    type: 'assistant',
    uuid: 'assistant-1',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'agent-tool', name: 'Agent', input: { prompt: 'wait' } }]
    }
  })
  emit({
    ...root,
    type: 'system',
    subtype: 'task_started',
    task_id: 'agent-task',
    tool_use_id: 'agent-tool',
    is_backgrounded: false,
    task_type: 'local_agent',
    uuid: 'task-started-1'
  })
  await expect(
    adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-2',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'change course' }] },
      fence: 7
    })
  ).resolves.toMatchObject({ state: 'admitted' })
  const steer = connection.sent[1]!
  expect(steer).toMatchObject({ priority: 'now' })
  expect(connection.calls).toContainEqual({
    subtype: 'background_tasks',
    params: { toolUseId: 'agent-tool' }
  })
  // Frame order recorded from Claude CLI 2.1.310 for a `now` steer: the cut-off step's result first.
  emit({
    ...root,
    type: 'result',
    subtype: 'success',
    uuid: 'result-1',
    is_error: false,
    num_turns: 1,
    terminal_reason: 'aborted_tools'
  })
  const turns = () =>
    journal.items.flatMap((item) => {
      const turn = readAgentJournalTurn(item.body)
      return turn ? [turn] : []
    })
  return { emit, steer, turns }
}

describe('a Claude steer during foreground work', () => {
  it('continues the running turn through the interrupt, not as a second or superseded turn', async () => {
    const { emit, steer, turns } = await steeredDuringSubagent()
    emit({
      ...root,
      type: 'system',
      subtype: 'init',
      uuid: 'init-2',
      model: 'claude-sonnet-5',
      apiKeySource: 'none'
    })
    emit({ ...steer, uuid: steer.uuid })
    emit({
      ...root,
      type: 'assistant',
      uuid: 'assistant-2',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Changed course.' }] }
    })
    emit({
      ...root,
      type: 'result',
      subtype: 'success',
      uuid: 'result-2',
      is_error: false,
      num_turns: 1,
      terminal_reason: 'completed'
    })

    expect(new Set(turns().map((turn) => turn.turnId))).toEqual(new Set(['turn-1']))
    expect(turns().at(-1)).toMatchObject({
      turnId: 'turn-1',
      state: 'completed',
      outcome: 'success'
    })
  })

  it("keeps a real result's own ending after the hand-off", async () => {
    const { emit, turns } = await steeredDuringSubagent()
    emit({
      ...root,
      type: 'result',
      subtype: 'error_during_execution',
      uuid: 'result-2',
      is_error: true,
      num_turns: 1,
      terminal_reason: 'api_error'
    })

    expect(turns().at(-1)).toMatchObject({ turnId: 'turn-1', outcome: 'failure' })
  })

  it('ends the turn as interrupted when it goes idle before the steer runs', async () => {
    const { emit, turns } = await steeredDuringSubagent()
    // A Stop can withdraw the queued steer, so Claude goes idle without another result.
    emit({
      ...root,
      type: 'system',
      subtype: 'session_state_changed',
      state: 'idle',
      uuid: 'idle-1'
    })

    expect(turns().at(-1)).toMatchObject({
      turnId: 'turn-1',
      state: 'interrupted',
      outcome: 'cancellation'
    })
  })
})

function childStreamAfterHandoff() {
  const writes: { body: AgentJournalItemBody; lifecycle?: boolean }[] = []
  const translator = createClaudeJournalTranslator({
    sink: {
      appendItem: (_identity, body, options) =>
        writes.push({ body, lifecycle: options?.lifecycle }),
      appendTombstone: () => {},
      publish: () => {}
    },
    steerAwaitingEcho: () => true
  })
  const frame = (message: Record<string, unknown>, observedAt: number, startsTurn = false) =>
    translator.handle({
      type: 'message',
      sessionId: 'orca-session',
      observedAt,
      ...(startsTurn ? { startsTurn: true } : {}),
      message: { session_id: 'claude-session', parent_tool_use_id: null, ...message }
    })
  frame({ type: 'user', uuid: 'prompt', message: { role: 'user', content: 'go' } }, 1_000, true)
  frame(
    {
      type: 'stream_event',
      uuid: 'child-delta',
      parent_tool_use_id: 'agent-tool',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Half' } }
    },
    2_000
  )
  frame(
    {
      type: 'result',
      subtype: 'success',
      uuid: 'r',
      is_error: false,
      terminal_reason: 'aborted_tools'
    },
    3_000
  )
  return { translator, frame, writes }
}

describe('a subagent text stream after a steer hand-off', () => {
  it('ends when the turn goes idle, so cancelled turns retain no blocks', () => {
    const { translator, frame, writes } = childStreamAfterHandoff()
    expect(translator.pendingStreamedBlocks).toBe(1)

    frame({ type: 'system', subtype: 'session_state_changed', state: 'idle', uuid: 'idle' }, 9_000)

    expect(translator.pendingStreamedBlocks).toBe(0)
    // The ending write must survive backpressure: no later frame would end the row.
    expect(writes.at(-2)).toMatchObject({
      body: { role: 'assistant', blocks: [{ type: 'text', text: 'Half' }] },
      lifecycle: true
    })
  })

  it('keeps streaming into the next turn when a new prompt supersedes this one', () => {
    const { translator, frame, writes } = childStreamAfterHandoff()

    frame(
      { type: 'user', uuid: 'prompt-2', message: { role: 'user', content: 'next' } },
      5_000,
      true
    )

    expect(translator.pendingStreamedBlocks).toBe(1)
    expect(writes.some((write) => write.lifecycle && write.body.kind === 'message')).toBe(false)
  })
})
