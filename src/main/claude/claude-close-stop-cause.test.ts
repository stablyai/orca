// Closing a Claude child settles its open turn in the adapter, with the cause the host handed the
// close. Only a stop the user aimed at this chat reads as their cancellation; an exit the adapter
// saw before the close settles as that exit.

import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalTurnLifecycle
} from '../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'
import {
  PROVIDER_SESSION_ID,
  adapterFor,
  fakeClaude,
  identityFor,
  tick
} from './claude-structured-session-test-support'

function turnSink() {
  const turns: AgentJournalTurnLifecycle[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (_identity, body: AgentJournalItemBody) => {
      const turn = readAgentJournalTurn(body)
      if (turn) {
        turns.push(turn)
      }
    },
    appendTombstone: () => {},
    publish: () => {}
  }
  return { sink, turns }
}

/** A live Claude child inside a turn the provider opened on its own (a background-task wake). */
async function childInsideTurn() {
  const claude = fakeClaude()
  const events: ClaudeStructuredSessionEvent[] = []
  const adapter = adapterFor(claude, {}, events)
  const { sink, turns } = turnSink()
  await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9', events: sink })
  const connection = claude.connections[0]!
  connection.handlers.onMessage?.({
    session_id: PROVIDER_SESSION_ID,
    type: 'assistant',
    uuid: 'assistant-1',
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] }
  })
  await tick()
  expect(turns.at(-1)).toMatchObject({ state: 'running' })
  return { adapter, connection, events, turns }
}

describe('a Claude close settles the open turn with the host-named cause', () => {
  it("records the user's close of this chat as their cancellation", async () => {
    const { adapter, events, turns } = await childInsideTurn()

    await expect(adapter.closeSession('session-1', 'user-close')).resolves.toBe(true)

    expect(turns.at(-1)).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
    expect(events.find((event) => event.type === 'ended')).toMatchObject({
      stopCause: 'user-close'
    })
  })

  it('leaves an eviction as news', async () => {
    const { adapter, turns } = await childInsideTurn()

    await adapter.closeSession('session-1', 'evict')

    expect(turns.at(-1)).toMatchObject({ state: 'interrupted' })
    expect(turns.at(-1)).not.toHaveProperty('outcome')
  })

  it('leaves a crash it saw before the user closed the chat as news', async () => {
    const { adapter, connection, events, turns } = await childInsideTurn()
    // The child dies on its own first; the user's close arrives while that exit is still settling.
    connection.handlers.onExit?.(new Error('provider exited'))

    await adapter.closeSession('session-1', 'user-close')
    await tick()

    const settled = turns.filter((turn) => turn.state !== 'running')
    expect(settled).toEqual([expect.objectContaining({ state: 'interrupted' })])
    expect(settled[0]).not.toHaveProperty('outcome')
    expect(events.filter((event) => event.type === 'ended')).toEqual([
      expect.objectContaining({ cause: 'unexpected-exit' })
    ])
  })
})
