import { describe, expect, it, vi } from 'vitest'
import {
  createPluginAgentStatusForwarder,
  pluginRuntimeDelegate,
  watchPluginWorkspaceContext
} from './plugin-runtime-binding'
import { projectPluginWorkspaceAgents } from './workers/plugin-workspace-projection'

const LEAF = '11111111-1111-4111-8111-111111111111'

function runtime(terminals: { handle: string; title: string | null; paneTitle?: string }[]) {
  return {
    resolveActiveWorktreeContext: vi.fn(async () => ({
      worktreeId: 'repo::/w',
      path: '/w',
      branch: 'refs/heads/main',
      displayName: 'w'
    })),
    listTerminals: vi.fn(async () => ({
      terminals: terminals.map((terminal, index) => ({
        ...terminal,
        tabId: `tab${index}`,
        leafId: LEAF
      }))
    })),
    sendTerminal: vi.fn(),
    dispatchPluginNotification: vi.fn()
  }
}

describe('agent.status.changed for plugins', () => {
  it('names the terminal and its title, in arrival order, only while someone listens', async () => {
    const delegate = pluginRuntimeDelegate(
      runtime([
        { handle: 'term_a', title: 'zsh' },
        { handle: 'term_b', title: 'codex', paneTitle: 'Reviewer' }
      ]),
      () => []
    )
    const events = { wantsEvent: vi.fn(() => true), emitEvent: vi.fn() }
    const forward = createPluginAgentStatusForwarder(delegate, events)
    const base = { workspaceId: 'repo::/w', state: 'working' as const, receivedAt: 1 }
    forward({ ...base, paneKey: `tab1:${LEAF}` })
    forward({ ...base, paneKey: 'tab9:unknown', state: 'done' })
    await vi.waitFor(() => expect(events.emitEvent).toHaveBeenCalledTimes(2))
    expect(events.emitEvent.mock.calls).toEqual([
      [
        'agent.status.changed',
        { ...base, paneKey: `tab1:${LEAF}`, terminalId: 'term_b', title: 'Reviewer' }
      ],
      ['agent.status.changed', { ...base, paneKey: 'tab9:unknown', state: 'done' }]
    ])
    events.wantsEvent.mockReturnValue(false)
    forward({ ...base, paneKey: `tab0:${LEAF}` })
    await Promise.resolve()
    expect(events.emitEvent).toHaveBeenCalledTimes(2)
  })
})

describe('agents.list projection', () => {
  it("lists the focused workspace's agents with their terminal, newest first", () => {
    const terminals = [{ id: 'term_a', title: 'codex', paneKey: `tab0:${LEAF}` }]
    expect(
      projectPluginWorkspaceAgents('w1', terminals, [
        {
          paneKey: `tab0:${LEAF}`,
          worktreeId: 'w1',
          state: 'working',
          stateStartedAt: 5,
          agentType: 'codex'
        },
        { paneKey: 'gone', worktreeId: 'w1', state: 'done', stateStartedAt: 9 },
        { paneKey: 'x', worktreeId: 'w2', state: 'done', stateStartedAt: 7 },
        {
          paneKey: 'y',
          worktreeId: 'w1',
          state: 'done',
          stateStartedAt: 8,
          providerSessionOnly: true
        }
      ])
    ).toEqual([
      { terminalId: null, title: null, agent: null, state: 'done', stateStartedAt: 9 },
      { terminalId: 'term_a', title: 'codex', agent: 'codex', state: 'working', stateStartedAt: 5 }
    ])
  })
})

describe('workspace.changed', () => {
  it('re-reads the context after session writes settle and emits only real changes', async () => {
    vi.useFakeTimers()
    try {
      const source = runtime([{ handle: 'term_a', title: 'zsh' }])
      const delegate = pluginRuntimeDelegate(source, () => [])
      const events = { wantsEvent: vi.fn(() => true), emitEvent: vi.fn() }
      let written: () => void = () => undefined
      const stop = watchPluginWorkspaceContext({
        delegate,
        events,
        onSessionWritten: (listener) => {
          written = listener
          return () => undefined
        },
        delayMs: 10
      })
      written()
      written()
      await vi.advanceTimersByTimeAsync(20)
      expect(events.emitEvent).toHaveBeenCalledWith('workspace.changed', {
        context: { branch: 'main', displayName: 'w', terminals: [{ id: 'term_a', title: 'zsh' }] }
      })
      written()
      await vi.advanceTimersByTimeAsync(20)
      expect(events.emitEvent).toHaveBeenCalledOnce()
      source.listTerminals.mockResolvedValueOnce({ terminals: [] })
      written()
      await vi.advanceTimersByTimeAsync(20)
      expect(events.emitEvent).toHaveBeenLastCalledWith('workspace.changed', {
        context: { branch: 'main', displayName: 'w', terminals: [] }
      })
      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
