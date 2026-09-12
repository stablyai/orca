import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentEntryCompletionAt } from '../../shared/agent-completion-time'
import { AgentHookServer, _internals } from './server'
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

function completionEntry(overrides: {
  state: 'done' | 'working'
  sessionBoundary?: boolean
  stateStartedAt?: number
  updatedAt?: number
}) {
  return {
    paneKey: PANE,
    state: overrides.state,
    updatedAt: overrides.updatedAt ?? 2_000,
    stateStartedAt: overrides.stateStartedAt ?? 1_500,
    sessionBoundary: overrides.sessionBoundary,
    stateHistory: []
  }
}

describe('Codex SessionStart mixed-version content semantics', () => {
  it('treats plain done without sessionBoundary as a finished turn', () => {
    const plainDone = completionEntry({ state: 'done' })
    // Same predicate as automation-run-completion-evidence and
    // automation-dispatch-completion: sessionBoundary is the only suppressor.
    const isAutomationCompletion =
      plainDone.state === 'done' &&
      plainDone.sessionBoundary !== true &&
      plainDone.updatedAt >= 1_000
    expect(agentEntryCompletionAt(plainDone)).toBe(1_500)
    expect(isAutomationCompletion).toBe(true)
  })

  it('does not treat sessionBoundary done as a finished turn', () => {
    const boundary = completionEntry({ state: 'done', sessionBoundary: true })
    const isAutomationCompletion =
      boundary.state === 'done' && boundary.sessionBoundary !== true && boundary.updatedAt >= 1_000
    expect(agentEntryCompletionAt(boundary)).toBeNull()
    expect(isAutomationCompletion).toBe(false)
  })

  it('clears an old-relay working SessionStart without applying a done row', () => {
    const server = new AgentHookServer()
    const clearListener = vi.fn()
    server.setPaneStatusClearListener(clearListener)
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        hookEventName: 'UserPromptSubmit',
        source: 'codex',
        payload: { state: 'working', prompt: 'old session', agentType: 'codex' }
      },
      'conn-1'
    )
    clearListener.mockClear()

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        hookEventName: 'SessionStart',
        source: 'codex',
        providerSession: { key: 'session_id', id: 'relay-new-session' },
        payload: { state: 'working', prompt: '', agentType: 'codex' }
      },
      'conn-1'
    )

    expect(clearListener).toHaveBeenCalledTimes(1)
    expect(server.getStatusSnapshot()).toEqual([])
    expect(server.getStatusSnapshot().some((row) => row.state === 'done')).toBe(false)
    expect(server._getStateForTests().lastProviderSessionByPaneKey.get(PANE)).toEqual({
      key: 'session_id',
      id: 'relay-new-session'
    })
  })

  it('does not apply a legacy plain-done SessionStart as a completed turn', () => {
    const server = new AgentHookServer()
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        hookEventName: 'UserPromptSubmit',
        source: 'codex',
        payload: { state: 'working', prompt: 'old session', agentType: 'codex' }
      },
      'conn-1'
    )
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        hookEventName: 'SessionStart',
        source: 'codex',
        payload: { state: 'done', prompt: '', agentType: 'codex' }
      },
      'conn-1'
    )

    const snapshot = server.getStatusSnapshot()
    expect(snapshot).toEqual([])
    expect(agentEntryCompletionAt(completionEntry({ state: 'done' }))).toBe(1_500)
    expect(snapshot.some((row) => row.state === 'done' && row.sessionBoundary !== true)).toBe(false)
  })

  it('treats a duplicate relayed SessionStart as an idempotent clear', () => {
    const server = new AgentHookServer()
    const clearListener = vi.fn()
    server.setPaneStatusClearListener(clearListener)
    server.ingestRemote(
      {
        paneKey: PANE,
        hookEventName: 'UserPromptSubmit',
        source: 'codex',
        payload: { state: 'working', prompt: 'old session', agentType: 'codex' }
      },
      'conn-1'
    )
    server.ingestRemote(
      {
        paneKey: PANE,
        hookEventName: 'SessionStart',
        source: 'codex',
        payload: { state: 'working', prompt: '', agentType: 'codex' }
      },
      'conn-1'
    )
    clearListener.mockClear()
    server.ingestRemote(
      {
        paneKey: PANE,
        hookEventName: 'SessionStart',
        source: 'codex',
        isReplay: true,
        payload: { state: 'working', prompt: '', agentType: 'codex' }
      },
      'conn-1'
    )

    expect(clearListener).not.toHaveBeenCalled()
    expect(server.getStatusSnapshot()).toEqual([])
  })

  it('does not let a relayed Codex SessionStart clear a different agent status', () => {
    const server = new AgentHookServer()
    server.ingestRemote(
      {
        paneKey: PANE,
        hookEventName: 'UserPromptSubmit',
        source: 'claude',
        payload: { state: 'working', prompt: 'parent session', agentType: 'claude' }
      },
      'conn-1'
    )
    server.ingestRemote(
      {
        paneKey: PANE,
        hookEventName: 'SessionStart',
        source: 'codex',
        payload: { state: 'working', prompt: '', agentType: 'codex' }
      },
      'conn-1'
    )

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: PANE,
        state: 'working',
        agentType: 'claude',
        prompt: 'parent session'
      })
    ])
  })

  it('broadcasts a local HTTP SessionStart clear once and keeps the next prompt working', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const clearListener = vi.fn()
      server.setPaneStatusClearListener(clearListener)
      const post = (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/codex`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload))
        })

      expect(
        (await post({ hook_event_name: 'UserPromptSubmit', prompt: 'old session' })).status
      ).toBe(204)
      clearListener.mockClear()
      expect(
        (await post({ hook_event_name: 'SessionStart', session_id: 'new-session' })).status
      ).toBe(204)
      expect(
        (await post({ hook_event_name: 'SessionStart', session_id: 'new-session' })).status
      ).toBe(204)
      expect(clearListener).toHaveBeenCalledTimes(1)
      expect(server.getStatusSnapshot()).toEqual([])

      expect(
        (await post({ hook_event_name: 'UserPromptSubmit', prompt: 'next turn' })).status
      ).toBe(204)
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          state: 'working',
          prompt: 'next turn',
          providerSession: { key: 'session_id', id: 'new-session' }
        })
      ])
    } finally {
      server.stop()
    }
  })
})
