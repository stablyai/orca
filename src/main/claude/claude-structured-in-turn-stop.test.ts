// A user's Stop inside a live Claude chat interrupts the turn before the host ends its child. The
// turn's end then comes from the CLI's result frame, which CLIs before 2.1.91 send with no
// terminal_reason.

import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { ClaudeControlRequestError } from './claude-stream-json-connection'
import {
  PROVIDER_SESSION_ID,
  USER_MESSAGE,
  adapterFor,
  fakeClaude,
  identityFor,
  type FakeConnection
} from './claude-structured-session-test-support'

const CUT_SHORT = {
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  session_id: PROVIDER_SESSION_ID,
  parent_tool_use_id: null
}

async function runningChat(claude: ReturnType<typeof fakeClaude>): Promise<{
  adapter: ReturnType<typeof adapterFor>
  bodies: Map<string, AgentJournalItemBody>
  connection: FakeConnection
  turnId: string
}> {
  const bodies = new Map<string, AgentJournalItemBody>()
  const adapter = adapterFor(claude)
  await adapter.acquire({
    identity: identityFor(),
    fence: 7,
    spawnToken: 'spawn-9',
    events: {
      appendItem: (identity, body) => bodies.set(agentJournalItemKey(identity), body),
      appendTombstone: (identity) => bodies.delete(agentJournalItemKey(identity)),
      publish: vi.fn()
    }
  })
  await adapter.dispatch({
    sessionId: 'session-1',
    clientMessageId: 'client-a',
    body: USER_MESSAGE,
    fence: 7
  })
  const connection = claude.connections[0]!
  // Claude adopts the client uuid for the echo that opens the turn.
  connection.handlers.onMessage?.({ ...connection.sent.at(-1)! })
  const turnId = [...bodies.values()]
    .map((body) => readAgentJournalTurn(body))
    .find((turn) => turn?.state === 'running')?.turnId
  if (!turnId) {
    throw new Error('expected a running turn')
  }
  return { adapter, bodies, connection, turnId }
}

function settled(bodies: Map<string, AgentJournalItemBody>, turnId: string) {
  return [...bodies.values()]
    .map((body) => readAgentJournalTurn(body))
    .find((turn) => turn?.turnId === turnId && turn.state !== 'running')
}

function providerRows(bodies: Map<string, AgentJournalItemBody>): string[] {
  return [...bodies.keys()].filter((key) => key.includes('provider-frame'))
}

describe("a user's Stop inside a live Claude chat", () => {
  it('records the turn the interrupt cut as their cancellation when the CLI names no reason', async () => {
    const claude = fakeClaude({
      routes: {
        // The CLI aborts the turn, then acknowledges the interrupt.
        interrupt: () => {
          claude.connections[0]!.handlers.onMessage?.(CUT_SHORT)
          return undefined
        }
      }
    })
    const { adapter, bodies, turnId } = await runningChat(claude)

    await expect(adapter.cancelTurn({ sessionId: 'session-1', turnId, fence: 7 })).resolves.toEqual(
      { cancelled: true }
    )

    expect(settled(bodies, turnId)).toMatchObject({
      state: 'interrupted',
      outcome: 'cancellation'
    })
    expect(providerRows(bodies)).toEqual([])
  })

  // The chat's Stop button names no turn: it stops whatever the conversation has open.
  it('records the open turn a Stop naming no turn cut as their cancellation', async () => {
    const claude = fakeClaude({
      routes: {
        interrupt: () => {
          claude.connections[0]!.handlers.onMessage?.(CUT_SHORT)
          return undefined
        }
      }
    })
    const { adapter, bodies, turnId } = await runningChat(claude)

    await expect(adapter.cancelTurn({ sessionId: 'session-1', fence: 7 })).resolves.toEqual({
      cancelled: true
    })

    expect(settled(bodies, turnId)).toMatchObject({
      state: 'interrupted',
      outcome: 'cancellation'
    })
    expect(providerRows(bodies)).toEqual([])
  })

  it('reads the same result with no Stop as a failure', async () => {
    const { bodies, connection, turnId } = await runningChat(fakeClaude())

    connection.handlers.onMessage?.(CUT_SHORT)

    expect(settled(bodies, turnId)).toMatchObject({ state: 'completed', outcome: 'failure' })
    expect(providerRows(bodies)).toHaveLength(1)
  })

  it('keeps a Stop naming no turn off the turn after it', async () => {
    const claude = fakeClaude({
      routes: {
        interrupt: () => {
          claude.connections[0]!.handlers.onMessage?.(CUT_SHORT)
          return undefined
        }
      }
    })
    const { adapter, bodies, connection } = await runningChat(claude)
    await adapter.cancelTurn({ sessionId: 'session-1', fence: 7 })

    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-b',
      body: USER_MESSAGE,
      fence: 7
    })
    connection.handlers.onMessage?.({ ...connection.sent.at(-1)! })
    const nextTurnId = [...bodies.values()]
      .map((body) => readAgentJournalTurn(body))
      .find((turn) => turn?.state === 'running')?.turnId
    if (!nextTurnId) {
      throw new Error('expected the next turn running')
    }
    connection.handlers.onMessage?.(CUT_SHORT)

    expect(settled(bodies, nextTurnId)).toMatchObject({ state: 'completed', outcome: 'failure' })
  })

  // The Stop ends the child next, so the turn it was asked for reads Interrupted however it ends.
  it.each([
    ['naming the turn', true],
    ['naming no turn', false]
  ] as const)(
    'reads a turn the CLI refused to interrupt as the user stopping it, %s',
    async (_label, named) => {
      const claude = fakeClaude({
        routes: {
          interrupt: () => {
            throw new ClaudeControlRequestError('interrupt', 'not running')
          }
        }
      })
      const { adapter, bodies, connection, turnId } = await runningChat(claude)

      await expect(
        adapter.cancelTurn({ sessionId: 'session-1', ...(named ? { turnId } : {}), fence: 7 })
      ).resolves.toEqual({ cancelled: false })
      connection.handlers.onMessage?.(CUT_SHORT)

      expect(settled(bodies, turnId)).toMatchObject({ outcome: 'cancellation' })
      expect(providerRows(bodies)).toHaveLength(0)
    }
  )
})
