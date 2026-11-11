import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { buildBody, PANE, RUNNING_SHELL } from '../server.test-fixtures'

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

describe('AgentHookServer listener replay', () => {
  it('infers a cancel of a live Claude main agent turn and keeps the shell it leaves running as monitoring', () => {
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
          payload: {
            state: 'working',
            prompt: 'run in background',
            agentType: 'claude',
            mainAgent: { state: 'working', stateStartedAt: 900 }
          }
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
          baselinePrompt: 'run in background',
          baselineAgentType: 'claude',
          intent: 'ctrl-c'
        })
      ).toBe(true)
      // Cancel the main agent without discarding live shell inventory or marking the working row interrupted.
      const inferred = server.getStatusSnapshot()[0]
      expect(inferred).toMatchObject({
        state: 'working',
        workingMode: 'monitoring',
        mainAgent: { state: 'done', outcome: 'cancellation', stateStartedAt: 1_500 }
      })
      expect(inferred.interrupted).toBeUndefined()
      expect(server._getStateForTests().claudeRunningNonAgentTaskPaneKeys.has(PANE)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("starts a relayed Claude pane's cancel clock at each cancel, not at an earlier one", () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      const relayTurn = (prompt: string, startedAt: number): void =>
        server.ingestRemote(
          {
            paneKey: PANE,
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            payload: {
              state: 'working',
              prompt,
              agentType: 'claude',
              mainAgent: { state: 'working', stateStartedAt: startedAt }
            }
          },
          'conn-1'
        )
      const cancel = (prompt: string): boolean => {
        const baseline = server.getStatusSnapshot()[0]
        return server.inferInterrupt({
          paneKey: PANE,
          baselineUpdatedAt: baseline.receivedAt,
          baselineStateStartedAt: baseline.stateStartedAt,
          baselinePrompt: prompt,
          baselineAgentType: 'claude',
          intent: 'ctrl-c'
        })
      }
      relayTurn('first', 900)
      vi.setSystemTime(1_500)
      expect(cancel('first')).toBe(true)

      // Relay-owned turns must not inherit the local record's earlier cancellation clock.
      vi.setSystemTime(5_000)
      relayTurn('second', 5_000)
      vi.setSystemTime(6_000)
      expect(cancel('second')).toBe(true)
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'done',
        mainAgent: { state: 'done', outcome: 'cancellation', stateStartedAt: 6_000 }
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('infers a cancel of a live Claude main agent turn beside a working subagent and keeps the row working', () => {
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
            prompt: 'delegate',
            agentType: 'claude',
            subagents: [{ id: 'a1', state: 'working', startedAt: 900 }],
            mainAgent: { state: 'working', stateStartedAt: 900 }
          }
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
          baselinePrompt: 'delegate',
          baselineAgentType: 'claude',
          intent: 'ctrl-c'
        })
      ).toBe(true)
      // Relayed rows carry their own child evidence; main-agent cancellation must preserve it.
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'working',
        subagents: [{ id: 'a1', state: 'working' }],
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })
      expect(server.getStatusSnapshot()[0].workingMode).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not infer a cancel at the idle prompt of a Claude row held open by child work', () => {
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
          payload: {
            state: 'working',
            workingMode: 'monitoring',
            prompt: 'run in background',
            agentType: 'claude',
            mainAgent: { state: 'done', stateStartedAt: 900 }
          }
        },
        'conn-1'
      )
      const baseline = server.getStatusSnapshot()[0]

      vi.setSystemTime(1_500)
      // Ctrl+C at an idle lead's prompt stops none of the child work shown.
      expect(
        server.inferInterrupt({
          paneKey: PANE,
          baselineUpdatedAt: baseline.receivedAt,
          baselineStateStartedAt: baseline.stateStartedAt,
          baselinePrompt: 'run in background',
          baselineAgentType: 'claude',
          intent: 'ctrl-c'
        })
      ).toBe(false)
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'working',
        workingMode: 'monitoring',
        mainAgent: { state: 'done' }
      })
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
      expect(baseline).toMatchObject({ state: 'working', workingMode: 'monitoring' })
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
})
