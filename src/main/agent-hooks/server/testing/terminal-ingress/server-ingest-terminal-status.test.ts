import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { PANE } from '../server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../../../../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../../../../telemetry/cohort-classifier', () => ({
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
  it('counts real hooks and program reports as progress, excluding lease renewals and replay', () => {
    vi.useFakeTimers()
    try {
      const server = new AgentHookServer()
      const payload = { state: 'working' as const, prompt: 'work', agentType: 'codex' as const }
      const hook = { paneKey: PANE, hookEventName: 'PreToolUse', toolUseId: 'call-1', payload }
      const program = {
        paneKey: PANE,
        connectionId: 'conn-1',
        fromProgramStatus: true as const,
        payload
      }
      vi.setSystemTime(1_000)
      server.ingestRemote(hook, 'conn-1')
      expect(server.producerProgress.get(PANE)?.lastProducerEventAt).toBe(1_000)
      vi.setSystemTime(2_000)
      server.ingestTerminalStatus(program)
      expect(server.producerProgress.get(PANE)?.lastProducerEventAt).toBe(2_000)
      vi.setSystemTime(3_000)
      server.ingestTerminalStatus({ ...program, renewsProgramStatusLease: true })
      server.ingestRemote({ ...hook, isReplay: true }, 'conn-1')
      server.ingestTerminalStatus({ ...program, isReplay: true })
      expect(server.producerProgress.get(PANE)?.lastProducerEventAt).toBe(2_000)
      vi.setSystemTime(4_000)
      server.ingestRemote({ ...hook, hookEventName: 'PostToolUse' }, 'conn-1')
      expect(server.producerProgress.get(PANE)?.lastProducerEventAt).toBe(4_000)
      expect([...server.producerProgress.get(PANE)!.tools.values()]).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

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

  // OSC lacks provider session identity; overwriting it would break mobile transcript subscriptions after restart.

  // Missing or unknown OSC agent identity cannot contradict the cached provider session.

  // Claude reports hookless slash commands (`/context`) as OSC 7501 working then done; the session lives on (#36033).
  it('keeps the cached provider session when an OSC status starts a turn after done', () => {
    const server = new AgentHookServer()
    const providerSession = { key: 'session_id' as const, id: 'claude-session-1' }

    server.ingestRemote(
      {
        paneKey: PANE,
        providerSession,
        payload: { state: 'done', prompt: 'first', agentType: 'claude' }
      },
      'conn-1'
    )
    for (const state of ['working', 'done'] as const) {
      server.ingestTerminalStatus({
        paneKey: PANE,
        connectionId: 'conn-1',
        payload: { state, prompt: '', agentType: 'claude' }
      })
    }

    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'done', providerSession })
  })

  it('drops the cached provider session when a relaunched agent starts a turn after the old one exited', () => {
    const server = new AgentHookServer()

    server.ingestRemote(
      {
        paneKey: PANE,
        providerSession: { key: 'session_id' as const, id: 'claude-session-1' },
        payload: { state: 'done', prompt: 'first', agentType: 'claude' }
      },
      'conn-1'
    )
    server.reconcileEndedProcessForPaneKeys([PANE], { preserveResumeIdentity: true })
    expect(server.getStatusSnapshot()[0]).toMatchObject({ providerSessionOnly: true })
    server.ingestTerminalStatus({
      paneKey: PANE,
      connectionId: 'conn-1',
      payload: { state: 'working', prompt: '', agentType: 'claude' }
    })

    expect(server.getStatusSnapshot()[0]?.providerSession).toBeUndefined()
  })
})

describe('the main agent fact across an OSC repaint', () => {
  it('carries the hook row main agent while OSC repaints the same state, and drops it on a state edge', () => {
    const server = new AgentHookServer()
    server.ingestRemote(
      {
        paneKey: PANE,
        source: 'claude',
        hookEventName: 'Stop',
        payload: {
          state: 'working',
          workingMode: 'monitoring',
          prompt: 'watch the build',
          agentType: 'claude',
          mainAgent: { state: 'done', stateStartedAt: 10 }
        }
      },
      'conn-1'
    )
    server.ingestTerminalStatus({
      paneKey: PANE,
      connectionId: 'conn-1',
      payload: {
        state: 'working',
        prompt: 'watch the build',
        agentType: 'claude',
        toolName: 'Bash'
      }
    })
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      toolName: 'Bash',
      mainAgent: { state: 'done', stateStartedAt: 10 }
    })

    // OSC has no main-agent turn evidence to date a turn edge.
    server.ingestTerminalStatus({
      paneKey: PANE,
      connectionId: 'conn-1',
      payload: { state: 'done', prompt: 'watch the build', agentType: 'claude' }
    })
    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'done' })
    expect(server.getStatusSnapshot()[0]).not.toHaveProperty('mainAgent')
  })
})
