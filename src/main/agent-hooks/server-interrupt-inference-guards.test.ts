import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, RUNNING_SHELL } from './server.test-fixtures'

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
  it('keeps Codex lead state terminal after an inferred interrupt', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      const listener = vi.fn()
      server.setListener(listener)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          providerSession: { key: 'session_id', id: 'codex-interrupt-session-1' },
          hookEventName: 'UserPromptSubmit',
          payload: {
            state: 'working',
            prompt: 'long task',
            agentType: 'codex',
            model: 'gpt-5.6-sol'
          }
        },
        'conn-1'
      )
      const baseline = server.getStatusSnapshot()[0]

      vi.setSystemTime(1_500)
      const applied = server.inferInterrupt({
        paneKey: PANE,
        baselineUpdatedAt: baseline.receivedAt,
        baselineStateStartedAt: baseline.stateStartedAt,
        baselinePrompt: 'long task',
        baselineAgentType: 'codex',
        intent: 'plain-escape'
      })

      expect(applied).toBe(true)
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          state: 'done',
          prompt: 'long task',
          agentType: 'codex',
          providerSession: { key: 'session_id', id: 'codex-interrupt-session-1' },
          interrupted: true,
          receivedAt: 1_500,
          stateStartedAt: 1_500
        })
      ])
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          paneKey: PANE,
          providerSession: { key: 'session_id', id: 'codex-interrupt-session-1' },
          payload: expect.objectContaining({ state: 'done', interrupted: true })
        })
      )

      vi.setSystemTime(17_000)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hookEventName: 'SubagentStop',
          toolAgentId: 'delayed-child',
          payload: { state: 'done', prompt: 'long task', agentType: 'codex' }
        },
        'conn-1'
      )

      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'done',
        model: 'gpt-5.6-sol',
        prompt: 'long task'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not infer an interrupt while a subagent child is still working', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: {
            state: 'working',
            prompt: 'review loop',
            agentType: 'claude',
            // Why: a working pane can be child-driven while the lead is idle; Ctrl+C doesn't stop children, so no terminal-done may be inferred here.
            subagents: [{ id: 'a1', state: 'working', startedAt: 900 }]
          }
        },
        'conn-1'
      )
      const baseline = server.getStatusSnapshot()[0]

      vi.setSystemTime(1_500)
      const applied = server.inferInterrupt({
        paneKey: PANE,
        baselineUpdatedAt: baseline.receivedAt,
        baselineStateStartedAt: baseline.stateStartedAt,
        baselinePrompt: 'review loop',
        baselineAgentType: 'claude',
        intent: 'ctrl-c'
      })

      expect(applied).toBe(false)
      expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'working' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not infer an interrupt while Claude reports a background shell', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          claudeRunningNonAgentTask: true,
          payload: { state: 'working', prompt: 'run in background', agentType: 'claude' }
        },
        'conn-1'
      )
      let baseline = server.getStatusSnapshot()[0]

      vi.setSystemTime(1_500)
      expect(
        server.inferInterrupt({
          paneKey: PANE,
          baselineUpdatedAt: baseline.receivedAt,
          baselineStateStartedAt: baseline.stateStartedAt,
          baselinePrompt: 'run in background',
          baselineAgentType: 'claude',
          intent: 'plain-escape'
        })
      ).toBe(false)
      expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'working' })

      vi.setSystemTime(2_000)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          claudeRunningNonAgentTask: false,
          payload: { state: 'working', prompt: 'run in background', agentType: 'claude' }
        },
        'conn-1'
      )
      baseline = server.getStatusSnapshot()[0]

      vi.setSystemTime(2_500)
      expect(
        server.inferInterrupt({
          paneKey: PANE,
          baselineUpdatedAt: baseline.receivedAt,
          baselineStateStartedAt: baseline.stateStartedAt,
          baselinePrompt: 'run in background',
          baselineAgentType: 'claude',
          intent: 'plain-escape'
        })
      ).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('blocks local HTTP interrupt inference for provider-owned work without exposing transport metadata', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const postHook = (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload))
        })

      await expect(
        postHook({ hook_event_name: 'UserPromptSubmit', prompt: 'run in background' })
      ).resolves.toMatchObject({ status: 204 })
      await expect(
        postHook({ hook_event_name: 'Stop', background_tasks: [RUNNING_SHELL] })
      ).resolves.toMatchObject({ status: 204 })
      const baseline = server.getStatusSnapshot()[0]

      expect(baseline).not.toHaveProperty('claudeRunningNonAgentTask')
      expect(
        server.inferInterrupt({
          paneKey: PANE,
          baselineUpdatedAt: baseline.receivedAt,
          baselineStateStartedAt: baseline.stateStartedAt,
          baselinePrompt: 'run in background',
          baselineAgentType: 'claude',
          intent: 'plain-escape'
        })
      ).toBe(false)

      await expect(
        postHook({
          hook_event_name: 'Stop',
          background_tasks: [],
          session_crons: [{ id: 'cron-1' }]
        })
      ).resolves.toMatchObject({ status: 204 })
      const cronBaseline = server.getStatusSnapshot()[0]
      expect(server._getStateForTests().claudeActiveSessionCronPaneKeys.has(PANE)).toBe(true)
      expect(
        server.inferInterrupt({
          paneKey: PANE,
          baselineUpdatedAt: cronBaseline.receivedAt,
          baselineStateStartedAt: cronBaseline.stateStartedAt,
          baselinePrompt: 'run in background',
          baselineAgentType: 'claude',
          intent: 'ctrl-c'
        })
      ).toBe(false)
    } finally {
      server.stop()
    }
  })

  it('uses replayed Claude background metadata only before a live observation', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          isReplay: true,
          claudeRunningNonAgentTask: true,
          payload: { state: 'working', prompt: 'stale replay', agentType: 'claude' }
        },
        'conn-1'
      )
      const baseline = server.getStatusSnapshot()[0]

      vi.setSystemTime(1_500)
      expect(
        server.inferInterrupt({
          paneKey: PANE,
          baselineUpdatedAt: baseline.receivedAt,
          baselineStateStartedAt: baseline.stateStartedAt,
          baselinePrompt: 'stale replay',
          baselineAgentType: 'claude',
          intent: 'ctrl-c'
        })
      ).toBe(false)

      vi.setSystemTime(1_500)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          claudeRunningNonAgentTask: false,
          payload: { state: 'working', prompt: 'stale replay', agentType: 'claude' }
        },
        'conn-1'
      )
      vi.setSystemTime(2_000)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          isReplay: true,
          claudeRunningNonAgentTask: true,
          payload: { state: 'working', prompt: 'stale replay', agentType: 'claude' }
        },
        'conn-1'
      )
      const liveBaseline = server.getStatusSnapshot()[0]

      vi.setSystemTime(2_500)
      expect(
        server.inferInterrupt({
          paneKey: PANE,
          baselineUpdatedAt: liveBaseline.receivedAt,
          baselineStateStartedAt: liveBaseline.stateStartedAt,
          baselinePrompt: 'stale replay',
          baselineAgentType: 'claude',
          intent: 'ctrl-c'
        })
      ).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not apply Claude background metadata from a rejected remote status', () => {
    const server = new AgentHookServer()
    server.ingestRemote(
      {
        paneKey: PANE,
        hookEventName: 'PermissionRequest',
        claudeRunningNonAgentTask: true,
        payload: {
          state: 'waiting',
          prompt: 'approve shell',
          agentType: 'claude',
          toolName: 'Bash'
        }
      },
      'conn-1'
    )
    const waiting = server.getStatusSnapshot()[0]

    server.ingestRemote(
      {
        paneKey: PANE,
        hookEventName: 'PreToolUse',
        claudeRunningNonAgentTask: false,
        payload: {
          state: 'working',
          prompt: 'approve shell',
          agentType: 'claude',
          toolName: 'OtherTool'
        }
      },
      'conn-1'
    )

    expect(server.getStatusSnapshot()[0]).toEqual(waiting)
    expect(server._getStateForTests().claudeRunningNonAgentTaskPaneKeys.has(PANE)).toBe(true)
  })

  it('carries idle subagent rows through an inferred interrupt', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: {
            state: 'working',
            prompt: 'wrap up',
            agentType: 'claude',
            subagents: [{ id: 'a1', state: 'idle', startedAt: 900, agentType: 'probe1' }]
          }
        },
        'conn-1'
      )
      const baseline = server.getStatusSnapshot()[0]

      vi.setSystemTime(1_500)
      const applied = server.inferInterrupt({
        paneKey: PANE,
        baselineUpdatedAt: baseline.receivedAt,
        baselineStateStartedAt: baseline.stateStartedAt,
        baselinePrompt: 'wrap up',
        baselineAgentType: 'claude',
        intent: 'ctrl-c'
      })

      expect(applied).toBe(true)
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'done',
        interrupted: true,
        subagents: [expect.objectContaining({ id: 'a1', state: 'idle' })]
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves an inferred interrupted row when OpenCode immediately reports SessionIdle', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      const listener = vi.fn()
      server.setListener(listener)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: { state: 'working', prompt: 'long task', agentType: 'opencode' }
        },
        'conn-1'
      )
      const baseline = server.getStatusSnapshot()[0]

      vi.setSystemTime(1_500)
      expect(
        server.inferInterrupt({
          paneKey: PANE,
          baselineUpdatedAt: baseline.receivedAt,
          baselineStateStartedAt: baseline.stateStartedAt,
          baselinePrompt: 'long task',
          baselineAgentType: 'opencode',
          intent: 'plain-escape',
          inputCount: 2
        })
      ).toBe(true)

      vi.setSystemTime(1_501)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: { state: 'done', prompt: 'long task', agentType: 'opencode' }
        },
        'conn-1'
      )

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          state: 'done',
          prompt: 'long task',
          agentType: 'opencode',
          interrupted: true,
          receivedAt: 1_500,
          stateStartedAt: 1_500
        })
      ])
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          paneKey: PANE,
          payload: expect.objectContaining({ state: 'done', interrupted: true })
        })
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects inferred interrupts when a same-millisecond prompt update changed the row', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: { state: 'working', prompt: 'first task', agentType: 'codex' }
        },
        'conn-1'
      )
      const baseline = server.getStatusSnapshot()[0]
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: { state: 'working', prompt: 'second task', agentType: 'codex' }
        },
        'conn-1'
      )

      const applied = server.inferInterrupt({
        paneKey: PANE,
        baselineUpdatedAt: baseline.receivedAt,
        baselineStateStartedAt: baseline.stateStartedAt,
        baselinePrompt: 'first task',
        baselineAgentType: 'codex',
        intent: 'plain-escape'
      })

      expect(applied).toBe(false)
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          state: 'working',
          prompt: 'second task',
          agentType: 'codex'
        })
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['opencode', 'copilot'] as const)(
    'rejects single plain Escape inference for %s',
    (agentType) => {
      vi.useFakeTimers()
      vi.setSystemTime(1_000)
      try {
        const server = new AgentHookServer()
        server.ingestRemote(
          {
            paneKey: PANE,
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            payload: { state: 'working', prompt: 'long task', agentType }
          },
          'conn-1'
        )
        const baseline = server.getStatusSnapshot()[0]

        vi.setSystemTime(1_500)
        const applied = server.inferInterrupt({
          paneKey: PANE,
          baselineUpdatedAt: baseline.receivedAt,
          baselineStateStartedAt: baseline.stateStartedAt,
          baselinePrompt: 'long task',
          baselineAgentType: agentType,
          intent: 'plain-escape'
        })

        expect(applied).toBe(false)
        expect(server.getStatusSnapshot()).toEqual([
          expect.objectContaining({
            state: 'working',
            prompt: 'long task',
            agentType
          })
        ])
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it.each(['opencode', 'copilot'] as const)(
    'accepts double plain Escape inference for %s',
    (agentType) => {
      vi.useFakeTimers()
      vi.setSystemTime(1_000)
      try {
        const server = new AgentHookServer()
        server.ingestRemote(
          {
            paneKey: PANE,
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            payload: { state: 'working', prompt: 'long task', agentType }
          },
          'conn-1'
        )
        const baseline = server.getStatusSnapshot()[0]

        vi.setSystemTime(1_500)
        const applied = server.inferInterrupt({
          paneKey: PANE,
          baselineUpdatedAt: baseline.receivedAt,
          baselineStateStartedAt: baseline.stateStartedAt,
          baselinePrompt: 'long task',
          baselineAgentType: agentType,
          intent: 'plain-escape',
          inputCount: 2
        })

        expect(applied).toBe(true)
        expect(server.getStatusSnapshot()).toEqual([
          expect.objectContaining({
            state: 'done',
            prompt: 'long task',
            agentType,
            interrupted: true
          })
        ])
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it('rejects Ctrl+C inference for Droid', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: { state: 'working', prompt: 'long task', agentType: 'droid' }
        },
        'conn-1'
      )
      const baseline = server.getStatusSnapshot()[0]

      vi.setSystemTime(1_500)
      const applied = server.inferInterrupt({
        paneKey: PANE,
        baselineUpdatedAt: baseline.receivedAt,
        baselineStateStartedAt: baseline.stateStartedAt,
        baselinePrompt: 'long task',
        baselineAgentType: 'droid',
        intent: 'ctrl-c'
      })

      expect(applied).toBe(false)
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          state: 'working',
          prompt: 'long task',
          agentType: 'droid'
        })
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})
