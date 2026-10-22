import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../../shared/runtime-types'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  HEADLESS_THIRD_LEAF_ID as THIRD_LEAF_ID,
  TEST_WORKTREE_ID
} from '../../orca-runtime-test-fixtures.spec'
import {
  SURFACE_PTYS,
  SURFACE_TAB_ID,
  captureSurfaceReplies,
  mountedSurfaceGraph,
  recordedSurfaceReplies,
  surfaceRuntime
} from './terminal-surface-replies.test-fixture'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const golden = (name: string): string =>
  recordedSurfaceReplies(path.join(__dirname, '__fixtures__', name))

const MOUNTED = Object.keys(SURFACE_PTYS).map((leafId, index) => ({
  tabId: SURFACE_TAB_ID,
  leafId,
  paneRuntimeId: index + 1,
  paneTitle: null
}))

// Layout-owner build: main answers from its own layout and terminal bindings.
describe('terminal replies from main (switch on)', () => {
  it('match the window-owned build when the window sends only what it mounts', async () => {
    const { runtime } = surfaceRuntime()
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mountedLeaves: MOUNTED })

    // Older readers skip the added verdict; every field they read is unchanged.
    expect(await captureSurfaceReplies(runtime, { ignore: ['verdict'] })).toBe(
      golden('terminal-surface-replies-desktop.json')
    )
    const listed = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(listed.terminals.map((terminal) => terminal.verdict)).toEqual(['live', 'live'])
  })

  it('list the saved panes with no window, under their saved tab', async () => {
    const { runtime } = surfaceRuntime()
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

    const listed = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(
      listed.terminals.map(({ tabId, leafId, ptyId, title, connected }) => ({
        tabId,
        leafId,
        ptyId,
        title,
        connected
      }))
    ).toEqual([
      {
        tabId: SURFACE_TAB_ID,
        leafId: HEADLESS_LEAF_ID,
        ptyId: 'pty-a',
        title: 'Persisted Terminal',
        connected: true
      },
      {
        tabId: SURFACE_TAB_ID,
        leafId: HEADLESS_SECOND_LEAF_ID,
        ptyId: 'pty-b',
        title: 'Persisted Terminal',
        connected: true
      }
    ])
    expect(runtime.getStatus()).toMatchObject({
      graphStatus: 'ready',
      liveTabCount: 1,
      liveLeafCount: 2
    })
  })

  it('keep answering after the window closes', async () => {
    const { runtime } = surfaceRuntime()
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mountedLeaves: MOUNTED })

    runtime.markGraphUnavailable(1)

    const listed = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(
      listed.terminals.map(({ tabId, leafId, orphaned, title }) => ({
        tabId,
        leafId,
        orphaned,
        title
      }))
    ).toEqual(
      [HEADLESS_LEAF_ID, HEADLESS_SECOND_LEAF_ID].map((leafId) => ({
        tabId: SURFACE_TAB_ID,
        leafId,
        orphaned: false,
        title: 'Persisted Terminal'
      }))
    )
    expect(runtime.getStatus()).toMatchObject({ graphStatus: 'ready', liveLeafCount: 2 })
    const shown = await runtime.showTerminal(listed.terminals[0]!.handle)
    expect(shown).toMatchObject({ tabId: SURFACE_TAB_ID, ptyId: 'pty-a', paneRuntimeId: -1 })
  })

  it('list a pane split into the layout before any window shows it', async () => {
    const { runtime, store, setSession } = surfaceRuntime()
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mountedLeaves: MOUNTED })
    const session = store.getSession()
    const layout = session.terminalLayoutsByTabId[SURFACE_TAB_ID]!
    setSession({
      ...session,
      terminalLayoutsByTabId: {
        [SURFACE_TAB_ID]: {
          ...layout,
          root: {
            type: 'split',
            direction: 'vertical',
            first: layout.root!,
            second: { type: 'leaf', leafId: THIRD_LEAF_ID }
          },
          ptyIdsByLeafId: { ...layout.ptyIdsByLeafId, [THIRD_LEAF_ID]: 'pty-c' }
        }
      }
    })
    runtime.registerPty('pty-c', TEST_WORKTREE_ID)
    await Promise.resolve()

    const listed = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(listed.terminals.map((terminal) => terminal.ptyId)).toEqual(['pty-a', 'pty-b', 'pty-c'])
  })

  it('close a tab by a pane handle in main, with no session row from the window', async () => {
    const { runtime, store, killed } = surfaceRuntime()
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mountedLeaves: MOUNTED })
    const listed = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    const second = listed.terminals.find((terminal) => terminal.ptyId === 'pty-b')!

    await expect(runtime.closeTerminalTab(second.handle)).resolves.toMatchObject({
      tabId: SURFACE_TAB_ID,
      closeMode: 'tab'
    })
    expect(store.getSession().tabsByWorktree[TEST_WORKTREE_ID] ?? []).toEqual([])
    expect(killed.toSorted()).toEqual(['pty-a', 'pty-b'])
  })

  it("close a tab by an unbound pane's handle, stopping the tab's other terminals", async () => {
    const { runtime, store, setSession, killed } = surfaceRuntime()
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mountedLeaves: MOUNTED })
    const session = store.getSession()
    const layout = session.terminalLayoutsByTabId[SURFACE_TAB_ID]!
    setSession({
      ...session,
      terminalLayoutsByTabId: {
        [SURFACE_TAB_ID]: {
          ...layout,
          root: {
            type: 'split',
            direction: 'vertical',
            first: layout.root!,
            second: { type: 'leaf', leafId: THIRD_LEAF_ID }
          }
        }
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const listed = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    const unbound = listed.terminals.find((terminal) => terminal.leafId === THIRD_LEAF_ID)!

    await runtime.closeTerminalTab(unbound.handle)

    expect(store.getSession().tabsByWorktree[TEST_WORKTREE_ID] ?? []).toEqual([])
    expect(killed.toSorted()).toEqual(['pty-a', 'pty-b'])
  })

  it('close one pane of a split by its handle in main, leaving its sibling', async () => {
    const { runtime, store, killed } = surfaceRuntime()
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mountedLeaves: MOUNTED })
    const listed = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    const second = listed.terminals.find((terminal) => terminal.ptyId === 'pty-b')!

    await runtime.closeTerminal(second.handle)

    const layout = store.getSession().terminalLayoutsByTabId[SURFACE_TAB_ID]
    expect(layout?.root).toEqual({ type: 'leaf', leafId: HEADLESS_LEAF_ID })
    expect(killed).toEqual(['pty-b'])
  })

  it("record the pane main's layout binds, over a caller's stale claim", () => {
    const { runtime } = surfaceRuntime()
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mountedLeaves: MOUNTED })

    runtime.registerPty('pty-b', TEST_WORKTREE_ID, null, {
      tabId: 'stale-tab',
      leafId: HEADLESS_LEAF_ID
    })

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ptysById is the runtime's PTY registry; the test reads the record it keeps.
    const { ptysById } = runtime as unknown as {
      ptysById: Map<string, { tabId: string | null; paneKey: string | null }>
    }
    expect(ptysById.get('pty-b')).toMatchObject({
      tabId: SURFACE_TAB_ID,
      paneKey: `${SURFACE_TAB_ID}:${HEADLESS_SECOND_LEAF_ID}`
    })
  })

  it('reinstall after a graph sync reconnects a terminal, never inside it', async () => {
    const { runtime } = surfaceRuntime()
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, mountedSurfaceGraph())
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ptysById is the runtime's PTY registry; the test edits the record it keeps.
    const { ptysById } = runtime as unknown as { ptysById: Map<string, { connected: boolean }> }
    // Disconnected, not exited: the graph's leaf loop records it connected again.
    ptysById.get('pty-a')!.connected = false
    const installs: { depth: number; connected: boolean | undefined }[] = []
    let depth = 0
    const sync = runtime.syncWindowGraph.bind(runtime)
    vi.spyOn(runtime, 'syncWindowGraph').mockImplementation((windowId, graph) => {
      installs.push({ depth, connected: ptysById.get('pty-a')?.connected })
      depth += 1
      try {
        return sync(windowId, graph)
      } finally {
        depth -= 1
      }
    })

    runtime.syncWindowGraph(1, mountedSurfaceGraph())
    expect(installs).toHaveLength(1)
    await Promise.resolve()

    // One deferred reinstall, outside the sync, after the record says connected.
    expect(installs).toEqual([
      { depth: 0, connected: false },
      { depth: 0, connected: true }
    ])
    const listed = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(listed.terminals.map(({ ptyId, connected }) => ({ ptyId, connected }))).toEqual([
      { ptyId: 'pty-a', connected: true },
      { ptyId: 'pty-b', connected: true }
    ])
  })
})
