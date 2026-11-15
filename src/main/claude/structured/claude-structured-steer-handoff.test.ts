import { describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
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

describe('a Claude steer during foreground work', () => {
  it('continues the running turn through the interrupt, not as a second or superseded turn', async () => {
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

    // Frame order recorded from Claude CLI 2.1.310 for a `now` steer.
    emit({
      ...root,
      type: 'result',
      subtype: 'success',
      uuid: 'result-1',
      is_error: false,
      num_turns: 1,
      terminal_reason: 'aborted_tools'
    })
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

    const turns = journal.items.flatMap((item) => {
      const turn = readAgentJournalTurn(item.body)
      return turn ? [turn] : []
    })
    expect(new Set(turns.map((turn) => turn.turnId))).toEqual(new Set(['turn-1']))
    expect(turns.at(-1)).toMatchObject({ turnId: 'turn-1', state: 'completed', outcome: 'success' })
  })
})
