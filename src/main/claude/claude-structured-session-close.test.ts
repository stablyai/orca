import { describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type {
  ClaudeStructuredSessionAdapterDeps,
  ClaudeStructuredSessionEvent
} from './structured/claude-structured-session-state'
import {
  PROVIDER_SESSION_ID,
  adapterFor,
  fakeClaude,
  identityFor
} from './claude-structured-session-test-support'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import { AgentSessionAcquisitionRootExitObservedError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

describe('Claude published session close lifecycle', () => {
  it('lets the chat start again after a close that saw the root exit', async () => {
    const claude = fakeClaude()
    const adapter = adapterFor(claude)
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    const first = claude.connections[0]!
    first.exitVerdict = { root: 'exited', tree: 'unverifiable' }
    first.close = vi.fn<() => Promise<boolean>>().mockResolvedValue(false)
    await expect(adapter.closeSession('session-1')).rejects.toBeInstanceOf(
      AgentSessionAcquisitionRootExitObservedError
    )

    await adapter.acquire({ identity: identityFor(), fence: 8, spawnToken: 'spawn-10' })

    expect(claude.connections).toHaveLength(2)
    expect(first.close).toHaveBeenCalledTimes(1)
  })

  it('starts the chat over a live session whose close saw the root exit', async () => {
    const claude = fakeClaude()
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = adapterFor(claude, {}, events)
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    const first = claude.connections[0]!
    first.exitVerdict = { root: 'exited', tree: 'unverifiable' }
    first.close = vi.fn<() => Promise<boolean>>().mockResolvedValue(false)

    await adapter.acquire({ identity: identityFor(), fence: 8, spawnToken: 'spawn-10' })

    expect(claude.connections).toHaveLength(2)
    expect(events.filter((event) => event.type === 'ended')).toHaveLength(1)
  })

  it('ends the session even when the durable handle write rejects', async () => {
    const claude = fakeClaude()
    const events: ClaudeStructuredSessionEvent[] = []
    const persistenceError = new Error('store unavailable')
    const persistHandle = vi
      .fn<NonNullable<ClaudeStructuredSessionAdapterDeps['persistHandle']>>()
      .mockRejectedValueOnce(persistenceError)
      .mockResolvedValueOnce(undefined)
    const childWork: AgentChildWorkEvidence['type'][] = []
    const adapter = adapterFor(
      claude,
      {},
      events,
      [],
      undefined,
      persistHandle,
      (_sessionId, evidence) => childWork.push(...evidence.map((edge) => edge.type))
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
    expect(childWork).toEqual(['live'])
    const session = (
      adapter as unknown as {
        sessions: Map<string, { translator: { dispose: () => void } | null }>
      }
    ).sessions.get('session-1')
    const disposeTranslator = vi.spyOn(session!.translator!, 'dispose')

    await expect(adapter.closeSession('session-1')).resolves.toBe(true)
    await vi.waitFor(() => expect(persistHandle).toHaveBeenCalledOnce())
    expect(events.filter((event) => event.type === 'ended')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'handle')).toHaveLength(0)
    expect(disposeTranslator).toHaveBeenCalledOnce()
    // Session close cannot prove how unfinished child work ended.
    expect(childWork).toEqual(['live', 'session-ended'])

    await expect(adapter.closeSession('session-1')).resolves.toBe(true)
    expect(persistHandle).toHaveBeenCalledOnce()
    expect(events.filter((event) => event.type === 'ended')).toHaveLength(1)
    expect(disposeTranslator).toHaveBeenCalledOnce()
  })
})
