import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import {
  createHookListenerState,
  type HookListenerState
} from '../../shared/agent-hook-listener/listener-state'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import { createShedSubagentsField } from '../../shared/agent-hook-relay'
import { buildBody, PANE } from './server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AgentHookServer listener replay', () => {
  it('preserves Codex sibling and lead state across relay listener restarts', () => {
    const server = new AgentHookServer()
    const send = (state: HookListenerState, payload: Record<string, unknown>): void => {
      const event = normalizeHookPayload(state, 'codex', buildBody(payload), 'production')
      if (!event) {
        throw new Error('normalizeHookPayload rejected a known-good Codex fixture')
      }
      server.ingestRemote(event, 'conn-1')
    }

    const initialRelay = createHookListenerState()
    send(initialRelay, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'root-session',
      prompt: 'coordinate reviewers',
      model: 'gpt-5.4'
    })
    for (const id of ['child-a', 'child-b']) {
      send(initialRelay, {
        hook_event_name: 'SubagentStart',
        agent_id: id,
        agent_type: 'reviewer',
        model: 'gpt-5.4-mini'
      })
    }

    const restartedRelay = createHookListenerState()
    send(restartedRelay, { hook_event_name: 'SubagentStop', agent_id: 'child-a' })
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      model: 'gpt-5.4',
      providerSession: { key: 'session_id', id: 'root-session' },
      subagents: [expect.objectContaining({ id: 'child-b' })]
    })

    send(restartedRelay, {
      hook_event_name: 'Stop',
      session_id: 'root-session',
      model: 'gpt-5.4'
    })
    const restartedAgain = createHookListenerState()
    send(restartedAgain, { hook_event_name: 'SubagentStop', agent_id: 'child-b' })
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'done',
      model: 'gpt-5.4',
      providerSession: { key: 'session_id', id: 'root-session' },
      subagents: undefined
    })
  })

  it('does not carry a remote Codex roster across connection cleanup', () => {
    const server = new AgentHookServer()
    const child = (id: string) => ({
      id,
      state: 'working' as const,
      startedAt: 1
    })
    server.ingestRemote(
      {
        paneKey: PANE,
        hookEventName: 'SubagentStart',
        toolAgentId: 'old-child',
        payload: {
          state: 'working',
          prompt: '',
          agentType: 'codex',
          subagents: [child('old-child')]
        }
      },
      'conn-1'
    )

    server.clearStatusEntriesForConnection('conn-1')
    server.ingestRemote(
      {
        paneKey: PANE,
        hookEventName: 'SubagentStart',
        toolAgentId: 'new-child',
        payload: {
          state: 'working',
          prompt: '',
          agentType: 'codex',
          subagents: [child('new-child')]
        }
      },
      'conn-2'
    )

    expect(server.getStatusSnapshot()[0]?.subagents).toEqual([child('new-child')])
  })

  it('restores a subagent roster the relay shed to fit the frame', () => {
    const server = new AgentHookServer()
    const roster = [
      { id: 'reviewer-1', agentType: 'reviewer', state: 'working' as const, startedAt: 1 }
    ]
    server.ingestRemote(
      {
        paneKey: PANE,
        payload: { state: 'working', prompt: 'review', agentType: 'claude', subagents: roster }
      },
      'conn-1'
    )
    // The relay dropped the roster to fit an oversized frame and said so on the wire.
    server.ingestRemote(
      {
        paneKey: PANE,
        shedFields: ['lastAssistantMessage', createShedSubagentsField(roster)],
        payload: { state: 'done', prompt: 'review', agentType: 'claude' }
      },
      'conn-1'
    )
    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'done', subagents: roster })
  })

  it('lets an unmarked absent roster clear, so a finished team still retires', () => {
    const server = new AgentHookServer()
    server.ingestRemote(
      {
        paneKey: PANE,
        payload: {
          state: 'working',
          prompt: 'review',
          agentType: 'claude',
          subagents: [{ id: 'reviewer-1', agentType: 'reviewer', state: 'working', startedAt: 1 }]
        }
      },
      'conn-1'
    )
    server.ingestRemote(
      { paneKey: PANE, payload: { state: 'done', prompt: 'review', agentType: 'claude' } },
      'conn-1'
    )
    expect(server.getStatusSnapshot()[0]?.subagents).toBeUndefined()
  })

  it('does not carry Claude background work across connection cleanup', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      server.ingestRemote(
        {
          paneKey: PANE,
          claudeRunningNonAgentTask: true,
          payload: { state: 'working', prompt: 'old host', agentType: 'claude' }
        },
        'conn-1'
      )

      server.clearStatusEntriesForConnection('conn-1')
      server.ingestRemote(
        {
          paneKey: PANE,
          payload: { state: 'working', prompt: 'new host', agentType: 'claude' }
        },
        'conn-2'
      )
      const baseline = server.getStatusSnapshot()[0]
      vi.setSystemTime(1_500)

      expect(
        server.inferInterrupt({
          paneKey: PANE,
          baselineUpdatedAt: baseline.receivedAt,
          baselineStateStartedAt: baseline.stateStartedAt,
          baselinePrompt: 'new host',
          baselineAgentType: 'claude',
          intent: 'plain-escape'
        })
      ).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retains root Codex identity when relay child events omit it', () => {
    const server = new AgentHookServer()
    const providerSession = { key: 'session_id' as const, id: 'root-session' }

    server.ingestRemote(
      {
        paneKey: PANE,
        providerSession,
        payload: {
          state: 'working',
          prompt: 'coordinate reviewers',
          agentType: 'codex',
          model: 'gpt-5.4'
        }
      },
      'conn-1'
    )
    server.ingestRemote(
      {
        paneKey: PANE,
        toolAgentId: 'child-session',
        payload: { state: 'waiting', prompt: 'coordinate reviewers', agentType: 'codex' }
      },
      'conn-1'
    )
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      model: 'gpt-5.4',
      providerSession
    })

    server.ingestRemote(
      {
        paneKey: PANE,
        hookEventName: 'SubagentStop',
        toolAgentId: 'child-session',
        payload: { state: 'done', prompt: 'coordinate reviewers', agentType: 'codex' }
      },
      'conn-1'
    )
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'done',
      model: 'gpt-5.4',
      providerSession
    })
  })
})
