import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'
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

function frame(type: 'assistant' | 'user', uuid: string, content: unknown[]) {
  return {
    type,
    uuid,
    session_id: PROVIDER_SESSION_ID,
    parent_tool_use_id: null,
    message: { role: type, content }
  }
}

describe('a requested stop of a structured Claude chat', () => {
  it('reads interrupted, not failed or crashed, through the frames the stop makes Claude emit', async () => {
    const claude = fakeClaude({ replayUuid: 'turn-1' })
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = adapterFor(claude, {}, events)
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
    connection.handlers.onMessage?.(
      frame('assistant', 'assistant-1', [
        { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'sleep 120' } }
      ])
    )
    // What Claude 2.1.283 emitted within 35 ms of the supervised SIGTERM mid-tool, recorded
    // against the real CLI: the killed tool's result, a status frame, and no `result` frame.
    connection.close = async () => {
      connection.handlers.onMessage?.(
        frame('user', 'user-2', [
          { type: 'tool_result', tool_use_id: 'tool-1', is_error: true, content: 'Exit code 137' }
        ])
      )
      connection.handlers.onMessage?.({
        type: 'system',
        subtype: 'status',
        uuid: 'status-1',
        session_id: PROVIDER_SESSION_ID
      })
      connection.closed = true
      return true
    }

    await expect(adapter.closeSession('session-1')).resolves.toBe(true)

    const turns = journal.items.flatMap((item) => {
      const turn = readAgentJournalTurn(item.body)
      return turn ? [turn] : []
    })
    expect(turns.at(-1)).toMatchObject({ turnId: 'turn-1', state: 'interrupted' })
    const ended = events.filter((event) => event.type === 'ended')
    expect(ended).toEqual([expect.objectContaining({ reason: 'claude session closed' })])
    // The host ends the child's record on it, as the close Orca asked for, never as a crash.
    expect(ended[0]).toMatchObject({ cause: 'requested-close' })
  })
})
