import { describe, expect, it, vi } from 'vitest'
import './orca-runtime-test-mocks.spec'
import { createRuntime, TEST_WORKTREE_ID } from './orca-runtime-test-fixtures.spec'
import type { RuntimeRendererSyncWindowGraph } from '../../shared/runtime-session-contracts'
import { leaf } from '../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { NativeDesktopWindowGraphs, NATIVE_DESKTOP_GRAPH_ID } from './native-desktop-window-graphs'

function graph(id: number, generation = `renderer-${id}`): RuntimeRendererSyncWindowGraph {
  return {
    rendererGeneration: generation,
    tabs: [
      {
        tabId: `tab-${id}`,
        worktreeId: TEST_WORKTREE_ID,
        title: `Terminal ${id}`,
        activeLeafId: leaf(id),
        layout: { type: 'leaf', leafId: leaf(id) }
      }
    ],
    leaves: [
      {
        tabId: `tab-${id}`,
        worktreeId: TEST_WORKTREE_ID,
        leafId: leaf(id),
        paneRuntimeId: id,
        ptyId: `pty-${id}`
      }
    ]
  }
}

describe('native desktop window runtime graphs', () => {
  it('withdraws reloading windows, restores canceled navigation, and never revives a crashed graph', () => {
    const runtime = createRuntime()
    const graphs = new NativeDesktopWindowGraphs(runtime)
    graphs.sync(11, graph(1))
    graphs.sync(22, graph(2))
    const resumeFirst = graphs.suspend(11)
    expect(runtime.getStatus()).toMatchObject({ graphStatus: 'ready', liveTabCount: 1 })
    expect(graphs.windowIdsForTab('tab-1')).toEqual([])
    resumeFirst()
    expect(runtime.getStatus()).toMatchObject({ graphStatus: 'ready', liveTabCount: 2 })
    const resumeSecond = graphs.suspend(22)
    graphs.remove(22)
    resumeSecond()
    expect(graphs.windowIdsForTab('tab-2')).toEqual([])
    graphs.remove(11)
    expect(runtime.getStatus().graphStatus).toBe('unavailable')
    graphs.sync(22, graph(2, 'recovered'))
    expect(runtime.getStatus()).toMatchObject({ graphStatus: 'ready', liveTabCount: 1 })
  })
  it('keeps unchanged mobile snapshots and prunes a removed window workspace', () => {
    const runtime = createRuntime()
    const publish = vi.spyOn(runtime, 'syncWindowGraph')
    const graphs = new NativeDesktopWindowGraphs(runtime)
    const snapshot = {
      worktree: TEST_WORKTREE_ID,
      publicationEpoch: 'first',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    }
    graphs.sync(11, { ...graph(1), mobileSessionTabs: [snapshot] })
    graphs.sync(11, { ...graph(1), unchangedMobileSessionWorktrees: [TEST_WORKTREE_ID] })
    expect(publish.mock.calls.at(-1)?.[1].mobileSessionTabs).toHaveLength(1)
    graphs.sync(11, { ...graph(1), mobileSessionTabs: [] })
    expect(publish.mock.calls.at(-1)?.[1].mobileSessionTabs).toEqual([])
  })
  it('retains another window terminal and its handle when the first window closes', async () => {
    const runtime = createRuntime()
    const graphs = new NativeDesktopWindowGraphs(runtime)
    runtime.registerPty('pty-1', TEST_WORKTREE_ID, null, { tabId: 'tab-1', leafId: leaf(1) })
    runtime.registerPty('pty-2', TEST_WORKTREE_ID, null, { tabId: 'tab-2', leafId: leaf(2) })
    graphs.sync(11, graph(1))
    graphs.sync(22, graph(2))
    expect(runtime.getStatus()).toMatchObject({
      authoritativeWindowId: NATIVE_DESKTOP_GRAPH_ID,
      graphStatus: 'ready',
      liveTabCount: 2,
      liveLeafCount: 2
    })
    const before = (await runtime.listTerminals()).terminals.find((row) => row.ptyId === 'pty-2')
    if (!before) {
      throw new Error('Missing second window terminal')
    }
    graphs.remove(11)

    expect(runtime.getStatus()).toMatchObject({ graphStatus: 'ready', liveTabCount: 1 })
    expect(runtime.resolveLeafForHandle(before.handle)?.ptyId).toBe('pty-2')
    expect(graphs.windowIdsForTab('tab-2')).toEqual([22])
  })

  it('deduplicates a shared pane across windows and accepts a replacement renderer generation', () => {
    const runtime = createRuntime()
    const graphs = new NativeDesktopWindowGraphs(runtime)
    graphs.sync(11, graph(1))
    graphs.sync(22, graph(1, 'another-renderer'))
    expect(runtime.getStatus()).toMatchObject({ liveTabCount: 1, liveLeafCount: 1 })
    graphs.remove(11)
    graphs.sync(22, graph(1, 'reloaded-renderer'))
    expect(runtime.getStatus()).toMatchObject({ graphStatus: 'ready', liveTabCount: 1 })
    graphs.remove(22)
    expect(runtime.getStatus().graphStatus).toBe('unavailable')
  })

  it('rejects a tab id assigned to different workspaces without replacing the accepted graph', () => {
    const runtime = createRuntime()
    const graphs = new NativeDesktopWindowGraphs(runtime)
    graphs.sync(11, graph(1))
    const conflicting = graph(1)
    conflicting.tabs[0]!.worktreeId = 'another-repo::/different-workspace'
    expect(() => graphs.sync(22, conflicting)).toThrow('duplicate_runtime_tab_id')
    expect(runtime.getStatus()).toMatchObject({ graphStatus: 'ready', liveTabCount: 1 })
    expect(graphs.windowIdsForTab('tab-1')).toEqual([11])
  })
})
