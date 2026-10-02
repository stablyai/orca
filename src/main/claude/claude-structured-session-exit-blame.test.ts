// After a Claude start lands, only the child's own exit says Claude stopped; a fault on Orca's
// side that makes Orca close the child is Orca's.

import { describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { structuredAgentSessionCommandTurn } from '../native-chat/agent-session-wire/structured-agent-session-command-turn'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-adapter'
import {
  adapterFor,
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID
} from './claude-structured-session-test-support'

async function startedClaude(sink: StructuredAgentSessionEventSink) {
  const claude = fakeClaude()
  const events: ClaudeStructuredSessionEvent[] = []
  const adapter = adapterFor(claude, {}, events)
  await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9', events: sink })
  const ended = async () => {
    await vi.waitFor(() => expect(events.some((event) => event.type === 'ended')).toBe(true))
    return events.find((event) => event.type === 'ended')
  }
  return { connection: claude.connections[0], ended }
}

describe('what a started Claude session says ended it', () => {
  it('says Claude stopped when the child exits on its own', async () => {
    const { connection, ended } = await startedClaude({
      appendItem: () => {},
      appendTombstone: () => {},
      publish: () => {}
    })

    connection.handlers.onExit?.(new Error('claude stream-json exited (code 1): killed'))

    expect(await ended()).toMatchObject({
      cause: 'unexpected-exit',
      failure: { kind: 'providerExited' }
    })
  })

  it('blames Orca when a journal fault makes Orca close the child', async () => {
    const { connection, ended } = await startedClaude({
      appendItem: () => {},
      appendTombstone: () => {},
      publish: () => {},
      tryAppendResolvedItemAndPublish: () => ({ accepted: false, reason: 'failed' })
    })

    connection.handlers.onMessage?.({
      type: 'system',
      subtype: 'task_notification',
      session_id: PROVIDER_SESSION_ID,
      task_id: 'task-1',
      status: 'failed',
      summary: 'failed'
    })

    expect(await ended()).toMatchObject({
      reason: 'claude background task journal sink failed',
      cause: 'unexpected-exit',
      failure: { kind: 'hostFault' }
    })
    expect(connection.closeCount).toBeGreaterThanOrEqual(1)
  })

  it('rejects a message or a compaction for a child it no longer holds, with why it ended', async () => {
    const claude = fakeClaude()
    const adapter = adapterFor(claude, {}, [])
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    const connection = claude.connections[0]
    // The close cannot prove the child gone, so the adapter lets go of it and keeps its exit.
    connection.close = async () => false
    connection.handlers.onExit?.(new Error('claude stream-json exited (code 1): killed'))
    await adapter.drainObservedExits()

    const rejected = {
      state: 'rejected',
      rejection: { kind: 'providerExited' }
    }
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
        fence: 7
      })
    ).resolves.toMatchObject(rejected)
    const turn = structuredAgentSessionCommandTurn('client-2')
    await expect(
      adapter.compact({
        sessionId: 'session-1',
        fence: 7,
        command: {
          clientMessageId: 'client-2',
          ...turn,
          running: { kind: 'turn', turnId: turn.turnId, state: 'running' }
        }
      })
    ).resolves.toMatchObject(rejected)
    expect(connection.sent).toEqual([])
  })
})
