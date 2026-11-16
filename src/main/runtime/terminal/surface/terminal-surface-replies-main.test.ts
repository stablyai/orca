import 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  HEADLESS_THIRD_LEAF_ID as THIRD_LEAF_ID,
  TEST_WORKTREE_ID
} from '../../orca-runtime-tests/orca-runtime-test-fixtures.spec'
import {
  SURFACE_PTYS,
  SURFACE_TAB_ID,
  surfaceRuntime
} from './terminal-surface-replies.test-fixture'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const MOUNTED = Object.keys(SURFACE_PTYS).map((leafId, index) => ({
  tabId: SURFACE_TAB_ID,
  leafId,
  paneRuntimeId: index + 1,
  paneTitle: null
}))

describe('terminal replies from main (switch on)', () => {
  it('keep answering after the window closes', async () => {
    const { runtime } = surfaceRuntime()
    runtime.attachWindow(1)
    await runtime.syncWindowGraph(1, { tabs: [], leaves: [], mountedLeaves: MOUNTED })

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

  it("close a tab by an unbound pane's handle, stopping the tab's other terminals", async () => {
    const { runtime, store, setSession, killed } = surfaceRuntime()
    runtime.attachWindow(1)
    await runtime.syncWindowGraph(1, { tabs: [], leaves: [], mountedLeaves: MOUNTED })
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
    await runtime.syncWindowGraph(1, { tabs: [], leaves: [], mountedLeaves: MOUNTED })
    const listed = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    const second = listed.terminals.find((terminal) => terminal.ptyId === 'pty-b')!

    await runtime.closeTerminal(second.handle)

    const layout = store.getSession().terminalLayoutsByTabId[SURFACE_TAB_ID]
    expect(layout?.root).toEqual({ type: 'leaf', leafId: HEADLESS_LEAF_ID })
    expect(killed).toEqual(['pty-b'])
  })
})
