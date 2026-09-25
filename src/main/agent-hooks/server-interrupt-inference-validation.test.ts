import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { PANE, GOOD_PANE, FRESH_PANE } from './server.test-fixtures'

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
  it('rejects malformed inferred interrupt requests without throwing', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: { state: 'working', prompt: 'long task', agentType: 'codex' }
        },
        'conn-1'
      )
      const malformed: unknown[] = [
        {
          paneKey: 'tab-1:0',
          baselineUpdatedAt: 1_000,
          baselineStateStartedAt: 1_000,
          baselinePrompt: 'long task',
          baselineAgentType: 'codex',
          intent: 'ctrl-c'
        },
        {
          paneKey: PANE,
          baselineUpdatedAt: 1_000,
          baselineStateStartedAt: 1_000,
          baselinePrompt: 'long task',
          baselineAgentType: 'codex',
          intent: 'sigint'
        },
        {
          paneKey: PANE,
          baselineUpdatedAt: '1_000',
          baselineStateStartedAt: 1_000,
          baselinePrompt: 'long task',
          baselineAgentType: 'codex',
          intent: 'ctrl-c'
        },
        {
          paneKey: PANE,
          baselineUpdatedAt: 1_000,
          baselineStateStartedAt: 1_000,
          baselinePrompt: 123,
          baselineAgentType: 'codex',
          intent: 'ctrl-c'
        }
      ]

      for (const request of malformed) {
        expect(() =>
          server.inferInterrupt(request as Parameters<AgentHookServer['inferInterrupt']>[0])
        ).not.toThrow()
        expect(
          server.inferInterrupt(request as Parameters<AgentHookServer['inferInterrupt']>[0])
        ).toBe(false)
      }
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          state: 'working',
          prompt: 'long task',
          agentType: 'codex'
        })
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('allows an immediate same-prompt retry that carries cached turn detail', () => {
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
            prompt: 'retryable task',
            agentType: 'opencode',
            lastAssistantMessage: 'partial answer'
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
          baselinePrompt: 'retryable task',
          baselineAgentType: 'opencode',
          intent: 'ctrl-c'
        })
      ).toBe(true)

      vi.setSystemTime(2_000)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hasExplicitPrompt: true,
          payload: {
            state: 'working',
            prompt: 'retryable task',
            agentType: 'opencode',
            lastAssistantMessage: 'partial answer'
          }
        },
        'conn-1'
      )

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          state: 'working',
          prompt: 'retryable task',
          agentType: 'opencode',
          lastAssistantMessage: 'partial answer',
          receivedAt: 2_000,
          stateStartedAt: 2_000
        })
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('suppresses replayed same-prompt working events after an inferred interrupt', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hasExplicitPrompt: true,
          payload: {
            state: 'working',
            prompt: 'retryable task',
            agentType: 'opencode',
            lastAssistantMessage: 'partial answer'
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
          baselinePrompt: 'retryable task',
          baselineAgentType: 'opencode',
          intent: 'ctrl-c'
        })
      ).toBe(true)

      vi.setSystemTime(20_000)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hasExplicitPrompt: true,
          isReplay: true,
          payload: {
            state: 'working',
            prompt: 'retryable task',
            agentType: 'opencode',
            lastAssistantMessage: 'partial answer'
          }
        },
        'conn-1'
      )

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          state: 'done',
          prompt: 'retryable task',
          agentType: 'opencode',
          interrupted: true,
          receivedAt: 1_500,
          stateStartedAt: 1_500
        })
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('matches renderer unknown sentinel to an omitted hook agent type', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: { state: 'working', prompt: 'custom hook' }
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
          baselinePrompt: 'custom hook',
          baselineAgentType: 'unknown',
          intent: 'ctrl-c'
        })
      ).toBe(true)

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          state: 'done',
          prompt: 'custom hook',
          interrupted: true
        })
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects inferred interrupts for stale and non-working rows', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: { state: 'waiting', prompt: 'permission', agentType: 'codex' }
        },
        'conn-1'
      )
      const waiting = server.getStatusSnapshot()[0]
      expect(
        server.inferInterrupt({
          paneKey: PANE,
          baselineUpdatedAt: waiting.receivedAt,
          baselineStateStartedAt: waiting.stateStartedAt,
          baselinePrompt: 'permission',
          baselineAgentType: 'codex',
          intent: 'plain-escape'
        })
      ).toBe(false)

      server.ingestRemote(
        {
          paneKey: FRESH_PANE,
          tabId: 'tab-fresh',
          worktreeId: 'wt-1',
          payload: { state: 'working', prompt: 'old task', agentType: 'codex' }
        },
        'conn-1'
      )
      const stale = server.getStatusSnapshot().find((entry) => entry.paneKey === FRESH_PANE)!
      vi.setSystemTime(stale.receivedAt + 30 * 60 * 1000 + 1)
      expect(
        server.inferInterrupt({
          paneKey: FRESH_PANE,
          baselineUpdatedAt: stale.receivedAt,
          baselineStateStartedAt: stale.stateStartedAt,
          baselinePrompt: 'old task',
          baselineAgentType: 'codex',
          intent: 'plain-escape'
        })
      ).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('applies inferred interrupts for arbitrary agent types and Ctrl+C intent', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      server.ingestRemote(
        {
          paneKey: GOOD_PANE,
          tabId: 'tab-good',
          worktreeId: 'wt-1',
          payload: { state: 'working', prompt: 'custom task', agentType: 'custom-agent' }
        },
        'conn-1'
      )
      const baseline = server.getStatusSnapshot().find((entry) => entry.paneKey === GOOD_PANE)!

      vi.setSystemTime(1_250)
      expect(
        server.inferInterrupt({
          paneKey: GOOD_PANE,
          baselineUpdatedAt: baseline.receivedAt,
          baselineStateStartedAt: baseline.stateStartedAt,
          baselinePrompt: 'custom task',
          baselineAgentType: 'custom-agent',
          intent: 'ctrl-c'
        })
      ).toBe(true)

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: GOOD_PANE,
          state: 'done',
          prompt: 'custom task',
          agentType: 'custom-agent',
          interrupted: true
        })
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the main agent fact on an inferred interrupt', () => {
  it('publishes the synthesized done as a cancelled main agent turn', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: { state: 'working', prompt: 'long task', agentType: 'claude' }
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
          baselineAgentType: 'claude',
          intent: 'ctrl-c'
        })
      ).toBe(true)
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'done',
        interrupted: true,
        mainAgent: { state: 'done', outcome: 'cancellation', stateStartedAt: 1_500 }
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('folds a cancel of a working Codex main agent with the live child the row alone evidences', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      // Why no hookEventName: such a row never reconciles into main's Codex cache, so the row's
      // own subagents are the only child evidence — the seed must keep them from being retired.
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: {
            state: 'working',
            prompt: 'delegate',
            agentType: 'codex',
            subagents: [{ id: 'child-1', state: 'working', startedAt: 900 }],
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
          baselineAgentType: 'codex',
          intent: 'ctrl-c'
        })
      ).toBe(true)
      const inferred = server.getStatusSnapshot()[0]
      expect(inferred).toMatchObject({
        state: 'working',
        mainAgent: { state: 'done', outcome: 'cancellation', stateStartedAt: 1_500 },
        subagents: [expect.objectContaining({ id: 'child-1', state: 'working' })]
      })
      expect(inferred.interrupted).toBeUndefined()
      expect(inferred.workingMode).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a cancel at the idle prompt of a main agent a watch loop holds open', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      const settled = { state: 'done' as const, stateStartedAt: 800 }
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: {
            state: 'working',
            workingMode: 'monitoring',
            prompt: 'watch it',
            agentType: 'grok',
            mainAgent: settled
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
          baselinePrompt: 'watch it',
          baselineAgentType: 'grok',
          intent: 'ctrl-c'
        })
      ).toBe(false)
      // Why: the main agent already settled; Ctrl+C at its prompt stops nothing the row shows.
      expect(server.getStatusSnapshot()[0]).toEqual(baseline)
    } finally {
      vi.useRealTimers()
    }
  })
})
