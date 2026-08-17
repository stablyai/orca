import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { PANE } from './server.test-fixtures'

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

describe('AgentHookServer ingestTerminalStatus', () => {
  it('preserves a hook turn stamp when an OSC repaint omits hook-only completion text', () => {
    const server = new AgentHookServer()
    const listener = vi.fn()
    server.setListener(listener)

    server.ingestRemote(
      {
        paneKey: PANE,
        payload: { state: 'working', prompt: 'review the PR', agentType: 'claude' }
      },
      'conn-1'
    )
    listener.mockClear()
    server.ingestRemote(
      {
        paneKey: PANE,
        payload: {
          state: 'working',
          prompt: 'review the PR',
          agentType: 'claude',
          lastAssistantMessage: 'Review complete.',
          turnCompletedAt: 1_700_000_005_000
        }
      },
      'conn-1'
    )
    server.ingestTerminalStatus({
      paneKey: PANE,
      connectionId: 'conn-1',
      payload: { state: 'working', prompt: 'review the PR', agentType: 'claude' }
    })

    expect(listener).toHaveBeenCalledOnce()
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      lastAssistantMessage: 'Review complete.',
      turnCompletedAt: 1_700_000_005_000
    })

    server.ingestTerminalStatus({
      paneKey: PANE,
      connectionId: 'conn-1',
      payload: { state: 'done', prompt: 'review the PR', agentType: 'claude' }
    })

    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ state: 'done' }) })
    )
  })

  it('accepts an identical-prompt hook boundary after a stamped turn', () => {
    const server = new AgentHookServer()
    const listener = vi.fn()
    server.setListener(listener)

    server.ingestRemote(
      {
        paneKey: PANE,
        hookEventName: 'Stop',
        payload: {
          state: 'working',
          prompt: 'check status',
          agentType: 'claude',
          turnCompletedAt: 1_700_000_005_000
        }
      },
      'conn-1'
    )
    server.ingestRemote(
      {
        paneKey: PANE,
        hookEventName: 'UserPromptSubmit',
        payload: { state: 'working', prompt: 'check status', agentType: 'claude' }
      },
      'conn-1'
    )

    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          state: 'working',
          prompt: 'check status',
          turnCompletedAt: undefined
        })
      })
    )
    expect(server.getStatusSnapshot()[0]?.turnCompletedAt).toBeUndefined()
  })

  // Why: the OSC 9999 payload cannot carry a provider session, so letting it overwrite the row
  // erased the session id from persisted rows and from headless `orca serve` — which serves these
  // rows straight to mobile — leaving Chat UI with no transcript to subscribe to (#10630).
  it('keeps the cached provider session when an OSC status completes the turn', () => {
    const server = new AgentHookServer()
    const providerSession = { key: 'session_id' as const, id: 'claude-session-1' }

    server.ingestRemote(
      {
        paneKey: PANE,
        providerSession,
        payload: { state: 'working', prompt: 'summarize the diff', agentType: 'claude' }
      },
      'conn-1'
    )
    server.ingestTerminalStatus({
      paneKey: PANE,
      connectionId: 'conn-1',
      payload: { state: 'done', prompt: 'summarize the diff', agentType: 'claude' }
    })

    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'done', providerSession })
  })

  // Why: an OSC ping that names no agent — or the literal 'unknown', which
  // resolveAgentStatusIdentity treats identically — makes no claim about the pane's identity, so it
  // must not read as a mismatch. Missing this stripped the session from persisted and headless rows
  // while the live renderer kept it, blanking mobile chat only after a restart (#10630).
  it.each([undefined, 'unknown' as const])(
    'keeps the cached provider session when an OSC status claims agentType %s',
    (agentType) => {
      const server = new AgentHookServer()
      const providerSession = { key: 'session_id' as const, id: 'claude-session-1' }

      server.ingestRemote(
        {
          paneKey: PANE,
          providerSession,
          payload: { state: 'working', prompt: 'summarize the diff', agentType: 'claude' }
        },
        'conn-1'
      )
      server.ingestTerminalStatus({
        paneKey: PANE,
        connectionId: 'conn-1',
        payload: {
          state: 'done',
          prompt: 'summarize the diff',
          ...(agentType ? { agentType } : {})
        }
      })

      expect(server.getStatusSnapshot()[0]).toMatchObject({ providerSession })
    }
  )

  it('drops the cached provider session when an OSC status starts a new turn', () => {
    const server = new AgentHookServer()

    server.ingestRemote(
      {
        paneKey: PANE,
        providerSession: { key: 'session_id' as const, id: 'claude-session-1' },
        payload: { state: 'done', prompt: 'first', agentType: 'claude' }
      },
      'conn-1'
    )
    server.ingestTerminalStatus({
      paneKey: PANE,
      connectionId: 'conn-1',
      payload: { state: 'working', prompt: 'second', agentType: 'claude' }
    })

    expect(server.getStatusSnapshot()[0]?.providerSession).toBeUndefined()
  })

  it('forwards runtime terminal status through the normal listener and snapshot path', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      const listener = vi.fn()
      server.setListener(listener)

      server.ingestTerminalStatus({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: {
          state: 'working',
          prompt: 'ship it',
          agentType: 'codex'
        }
      })

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          connectionId: null,
          receivedAt: 1_000,
          stateStartedAt: 1_000,
          payload: {
            state: 'working',
            prompt: 'ship it',
            agentType: 'codex'
          }
        })
      )
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          connectionId: null,
          receivedAt: 1_000,
          stateStartedAt: 1_000,
          state: 'working',
          prompt: 'ship it',
          agentType: 'codex'
        })
      ])
      expect(trackMock).not.toHaveBeenCalledWith('agent_prompt_sent', expect.anything())
    } finally {
      vi.useRealTimers()
    }
  })

  it('suppresses exact duplicate runtime terminal status observations', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      const listener = vi.fn()
      server.setListener(listener)
      const event = {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: {
          state: 'working' as const,
          prompt: 'same turn',
          agentType: 'codex' as const
        }
      }

      server.ingestTerminalStatus(event)
      vi.setSystemTime(1_250)
      server.ingestTerminalStatus(event)

      expect(listener).toHaveBeenCalledTimes(1)
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          receivedAt: 1_000,
          stateStartedAt: 1_000,
          state: 'working',
          prompt: 'same turn'
        })
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves runtime terminal status connection identity', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      const listener = vi.fn()
      server.setListener(listener)

      server.ingestTerminalStatus({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        connectionId: 'ssh-conn-1',
        payload: {
          state: 'working',
          prompt: 'ship it',
          agentType: 'codex'
        }
      })

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          connectionId: 'ssh-conn-1',
          payload: {
            state: 'working',
            prompt: 'ship it',
            agentType: 'codex'
          }
        })
      )
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          connectionId: 'ssh-conn-1',
          state: 'working',
          prompt: 'ship it'
        })
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects runtime terminal status with mismatched tab identity', () => {
    const server = new AgentHookServer()
    const listener = vi.fn()
    server.setListener(listener)

    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'other-tab',
      worktreeId: 'wt-1',
      payload: {
        state: 'working',
        prompt: 'bad tab',
        agentType: 'codex'
      }
    })

    expect(listener).not.toHaveBeenCalled()
    expect(server.getStatusSnapshot()).toEqual([])
  })
})
