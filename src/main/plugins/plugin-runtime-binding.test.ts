import { describe, expect, it, vi } from 'vitest'
import {
  createPluginAgentStatusForwarder,
  pluginRuntimeDelegate,
  watchPluginWorkspaceContext
} from './plugin-runtime-binding'
import { projectPluginWorkspaceAgents } from './workers/plugin-workspace-projection'
import { PluginPanelBridge } from './panels/plugin-panel-bridge'
import type { ValidDiscoveredPlugin } from './plugin-discovery'

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

  it('stops listing terminals for queued events once the last listener goes away', async () => {
    const source = runtime([{ handle: 'term_a', title: 'zsh' }])
    const listing = Promise.withResolvers<{ terminals: [] }>()
    source.listTerminals.mockReturnValueOnce(listing.promise)
    const delegate = pluginRuntimeDelegate(source, () => [])
    const events = { wantsEvent: vi.fn(() => true), emitEvent: vi.fn() }
    const forward = createPluginAgentStatusForwarder(delegate, events)
    const base = { state: 'working' as const, receivedAt: 1, paneKey: `tab0:${LEAF}` }
    forward({ ...base, workspaceId: 'repo::/a' })
    await vi.waitFor(() => expect(source.listTerminals).toHaveBeenCalledOnce())
    forward({ ...base, workspaceId: 'repo::/b' })
    forward({ ...base, workspaceId: 'repo::/c' })
    // The panel closes while the first lookup is still running.
    events.wantsEvent.mockReturnValue(false)
    listing.resolve({ terminals: [] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(source.listTerminals).toHaveBeenCalledOnce()
    expect(events.emitEvent).toHaveBeenCalledOnce()
  })

  it('shares one terminal listing per workspace among events queued behind a lookup', async () => {
    const source = runtime([{ handle: 'term_a', title: 'zsh' }])
    let releaseFirst: () => void = () => undefined
    const first = source.listTerminals.getMockImplementation()!
    source.listTerminals.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (releaseFirst = resolve))
      return first()
    })
    const delegate = pluginRuntimeDelegate(source, () => [])
    const events = { wantsEvent: vi.fn(() => true), emitEvent: vi.fn() }
    const forward = createPluginAgentStatusForwarder(delegate, events)
    const base = { workspaceId: 'repo::/w', receivedAt: 1, paneKey: `tab0:${LEAF}` }
    forward({ ...base, state: 'working' })
    await vi.waitFor(() => expect(source.listTerminals).toHaveBeenCalledOnce())
    forward({ ...base, state: 'waiting' })
    forward({ ...base, state: 'done' })
    forward({ ...base, workspaceId: 'repo::/other', state: 'done' })
    releaseFirst()
    await vi.waitFor(() => expect(events.emitEvent).toHaveBeenCalledTimes(4))
    expect(source.listTerminals).toHaveBeenCalledTimes(3)
    expect(events.emitEvent.mock.calls.map(([, payload]) => payload)).toEqual([
      { ...base, state: 'working', terminalId: 'term_a', title: 'zsh' },
      { ...base, state: 'waiting', terminalId: 'term_a', title: 'zsh' },
      { ...base, state: 'done', terminalId: 'term_a', title: 'zsh' },
      { ...base, workspaceId: 'repo::/other', state: 'done', terminalId: 'term_a', title: 'zsh' }
    ])
  })

  it('keeps delivering, in order, past a failed listing or a throwing delivery', async () => {
    const source = runtime([{ handle: 'term_a', title: 'zsh' }])
    source.listTerminals.mockRejectedValueOnce(new Error('pty host gone'))
    const delegate = pluginRuntimeDelegate(source, () => [])
    const emitted: string[] = []
    const events = {
      wantsEvent: vi.fn(() => true),
      emitEvent: vi.fn((_event: string, payload: { state: string; terminalId?: string }) => {
        const { state, terminalId } = payload
        emitted.push(`${state}:${terminalId ?? '-'}`)
        if (state === 'waiting') {
          throw new Error('renderer gone')
        }
      })
    }
    const forward = createPluginAgentStatusForwarder(delegate, events)
    const base = { workspaceId: 'repo::/w', receivedAt: 1, paneKey: `tab0:${LEAF}` }
    forward({ ...base, state: 'working' })
    await vi.waitFor(() => expect(emitted).toEqual(['working:-']))
    forward({ ...base, state: 'waiting' })
    forward({ ...base, state: 'done' })
    await vi.waitFor(() => expect(emitted).toEqual(['working:-', 'waiting:term_a', 'done:term_a']))
    // The queue is not wedged: a later event still goes out.
    forward({ ...base, state: 'working' })
    await vi.waitFor(() => expect(emitted).toHaveLength(4))
    expect(emitted[3]).toBe('working:term_a')
  })

  it('lists terminals once for a storm of events, and delivers all of them in order', async () => {
    const source = runtime([{ handle: 'term_a', title: 'zsh' }])
    const delegate = pluginRuntimeDelegate(source, () => [])
    const events = { wantsEvent: vi.fn(() => true), emitEvent: vi.fn() }
    const forward = createPluginAgentStatusForwarder(delegate, events)
    for (let index = 0; index < 1000; index += 1) {
      forward({ workspaceId: 'repo::/w', state: 'working', receivedAt: index, paneKey: 'p' })
    }
    await vi.waitFor(() => expect(events.emitEvent).toHaveBeenCalledTimes(1000))
    expect(source.listTerminals).toHaveBeenCalledOnce()
    expect(events.emitEvent.mock.calls.map(([, payload]) => payload)).toEqual(
      [...Array(1000).keys()].map((receivedAt) => expect.objectContaining({ receivedAt }))
    )
  })

  it('delivers the backlog to a panel that reopened before the lookup finished', async () => {
    const source = runtime([{ handle: 'term_a', title: 'zsh' }])
    const listing = Promise.withResolvers<{ terminals: [] }>()
    source.listTerminals.mockReturnValueOnce(listing.promise)
    const delegate = pluginRuntimeDelegate(source, () => [])
    const events = { wantsEvent: vi.fn(() => true), emitEvent: vi.fn() }
    const forward = createPluginAgentStatusForwarder(delegate, events)
    const base = { state: 'working' as const, receivedAt: 1, paneKey: `tab0:${LEAF}` }
    forward({ ...base, workspaceId: 'repo::/a' })
    await vi.waitFor(() => expect(source.listTerminals).toHaveBeenCalledOnce())
    forward({ ...base, workspaceId: 'repo::/b' })
    // The panel closes and reopens while the first lookup runs: only interest at lookup time counts.
    events.wantsEvent.mockReturnValue(false)
    events.wantsEvent.mockReturnValue(true)
    listing.resolve({ terminals: [] })
    await vi.waitFor(() => expect(events.emitEvent).toHaveBeenCalledTimes(2))
    expect(events.emitEvent.mock.calls.map(([, payload]) => payload)).toEqual([
      expect.objectContaining({ workspaceId: 'repo::/a' }),
      expect.objectContaining({ workspaceId: 'repo::/b' })
    ])
  })

  it('serves several open panels, and stops looking up only when the last one closes', async () => {
    const plugin = { pluginKey: 'acme.board', manifest: {} }
    const bridge = new PluginPanelBridge({
      findApprovedPlugin: (key) =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: publishEvent reads only pluginKey.
        key === plugin.pluginKey ? (plugin as never as ValidDiscoveredPlugin) : null,
      grantedCapabilities: () => ['agent:read'],
      ensureWorker: async () => {
        throw new Error('no worker')
      },
      runningWorker: () => null,
      log: () => () => undefined,
      now: () => 0
    })
    const panels = ['panel-a', 'panel-b'].map((id) => {
      const deliver = vi.fn()
      bridge.open({ id, surface: 'panel', contributionId: 'board' }, plugin.pluginKey, deliver)
      bridge.subscribe(plugin.pluginKey, id, 'agent.status.changed')
      return deliver
    })
    const source = runtime([{ handle: 'term_a', title: 'zsh' }])
    const listing = Promise.withResolvers<{ terminals: [] }>()
    source.listTerminals.mockReturnValueOnce(listing.promise)
    const forward = createPluginAgentStatusForwarder(
      pluginRuntimeDelegate(source, () => []),
      {
        wantsEvent: (event) => bridge.hasSubscribers(event),
        emitEvent: (event, payload) => void bridge.publishEvent(event, payload)
      }
    )
    const base = { state: 'working' as const, receivedAt: 1, paneKey: `tab0:${LEAF}` }
    forward({ ...base, workspaceId: 'repo::/a' })
    await vi.waitFor(() => expect(source.listTerminals).toHaveBeenCalledOnce())
    forward({ ...base, workspaceId: 'repo::/b' })
    bridge.close('panel-a')
    listing.resolve({ terminals: [] })
    await vi.waitFor(() => expect(panels[1]).toHaveBeenCalledTimes(2))
    expect(panels[0]).not.toHaveBeenCalled()
    expect(source.listTerminals).toHaveBeenCalledTimes(2)
    // Last panel closes with events queued behind a slow lookup: the backlog is dropped.
    const slow = Promise.withResolvers<{ terminals: [] }>()
    source.listTerminals.mockReturnValueOnce(slow.promise)
    forward({ ...base, workspaceId: 'repo::/c' })
    await vi.waitFor(() => expect(source.listTerminals).toHaveBeenCalledTimes(3))
    forward({ ...base, workspaceId: 'repo::/d' })
    bridge.close('panel-b')
    slow.resolve({ terminals: [] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(source.listTerminals).toHaveBeenCalledTimes(3)
    expect(panels[1]).toHaveBeenCalledTimes(2)
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
        onStateWritten: () => () => undefined,
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
      // Same projected payload, different focused workspace: still a change.
      source.resolveActiveWorktreeContext.mockResolvedValueOnce({
        worktreeId: 'repo::/other',
        path: '/w',
        branch: 'refs/heads/main',
        displayName: 'w'
      })
      source.listTerminals.mockResolvedValueOnce({ terminals: [] })
      written()
      await vi.advanceTimersByTimeAsync(20)
      expect(events.emitEvent).toHaveBeenCalledTimes(3)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-reads the context after a catalog save such as a folder rename, not a UI save', async () => {
    vi.useFakeTimers()
    try {
      const delegate = pluginRuntimeDelegate(
        runtime([{ handle: 'term_a', title: 'zsh' }]),
        () => []
      )
      const events = { wantsEvent: vi.fn(() => true), emitEvent: vi.fn() }
      let saved: (domains: readonly string[] | undefined) => void = () => undefined
      const stop = watchPluginWorkspaceContext({
        delegate,
        events,
        onSessionWritten: () => () => undefined,
        onStateWritten: (listener) => {
          saved = listener
          return () => undefined
        },
        delayMs: 10
      })
      saved(['ui'])
      await vi.advanceTimersByTimeAsync(20)
      expect(events.emitEvent).not.toHaveBeenCalled()
      saved(['folderWorkspaces'])
      await vi.advanceTimersByTimeAsync(20)
      expect(events.emitEvent).toHaveBeenCalledWith('workspace.changed', expect.anything())
      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
