import { describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type {
  ClaudeStructuredSessionAdapterDeps,
  ClaudeStructuredSessionEvent
} from './claude-structured-session-adapter'
import {
  PROVIDER_SESSION_ID,
  adapterFor,
  fakeClaude,
  identityFor
} from './claude-structured-session-test-support'
import type { AgentSessionBackgroundTaskState } from '../../shared/agent-session-wire'

describe('Claude published session close lifecycle', () => {
  it('ends the session even when the durable handle write rejects', async () => {
    const claude = fakeClaude()
    const events: ClaudeStructuredSessionEvent[] = []
    const persistenceError = new Error('store unavailable')
    const persistHandle = vi
      .fn<NonNullable<ClaudeStructuredSessionAdapterDeps['persistHandle']>>()
      .mockRejectedValueOnce(persistenceError)
      .mockResolvedValueOnce(undefined)
    const backgroundStates: (AgentSessionBackgroundTaskState | null)[] = []
    const adapter = adapterFor(
      claude,
      {},
      events,
      [],
      undefined,
      undefined,
      persistHandle,
      (_sessionId, state) => backgroundStates.push(state)
    )
    const journalSink: StructuredAgentSessionEventSink = {
      appendItem: () => {},
      appendTombstone: () => {},
      publish: () => {}
    }
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      events: journalSink
    })
    claude.connections[0]!.handlers.onMessage?.({
      type: 'system',
      subtype: 'task_started',
      session_id: PROVIDER_SESSION_ID,
      uuid: 'task-start',
      task_id: 'background-1',
      task_type: 'local_agent',
      is_backgrounded: true
    })
    expect(backgroundStates).toEqual([
      { state: 'monitoring', tasks: [{ id: 'background-1', kind: 'agent' }] }
    ])
    const session = (
      adapter as unknown as {
        sessions: Map<string, { translator: { dispose: () => void } | null }>
      }
    ).sessions.get('session-1')
    const disposeTranslator = vi.spyOn(session!.translator!, 'dispose')

    await expect(adapter.closeSession('session-1')).rejects.toBe(persistenceError)
    // The child is provably dead; a failed cursor write may not suppress the end.
    expect(events.filter((event) => event.type === 'ended')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'handle')).toHaveLength(0)
    expect(disposeTranslator).toHaveBeenCalledOnce()
    expect(backgroundStates).toEqual([
      { state: 'monitoring', tasks: [{ id: 'background-1', kind: 'agent' }] },
      null
    ])

    await expect(adapter.closeSession('session-1')).resolves.toBe(true)
    expect(persistHandle).toHaveBeenCalledTimes(2)
    // The retry persists the same cursor without a second lifecycle end.
    expect(events.filter((event) => event.type === 'handle')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'ended')).toHaveLength(1)
    expect(disposeTranslator).toHaveBeenCalledOnce()
  })
})
