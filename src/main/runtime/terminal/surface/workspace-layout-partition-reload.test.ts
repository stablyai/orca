import { describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import type { LoadedWorkspaceLayoutRead } from '../../../../shared/workspace-layout/persistence/workspace-layout-load-types'
import { nameBasedLoadContext } from '../../../../shared/workspace-layout/persistence/workspace-layout-minted-ids'
import {
  addWorkspace,
  emptySession,
  leaf
} from '../../../../shared/workspace-layout/persistence/workspace-layout-session.test-fixture'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { loadWholePartition, reloadWorkspaces } from './workspace-layout-partition-reload'

vi.mock('../../../../shared/workspace-layout/layout-owner-switch', () => ({
  ORCA_LAYOUT_OWNER_IS_MAIN: true
}))

const A = 'repo-1::/a'
const B = 'repo-1::/b'
const C = 'repo-1::/c'
const PTY = 'repo-1::/a@@00000001'

type Pane = [string, string?]

function session(panes: { a: Pane; b: Pane; c?: Pane }): WorkspaceSessionState {
  let built = emptySession()
  for (const [key, id, pane] of [
    [A, 'tab-a', panes.a],
    [B, 'tab-b', panes.b],
    [C, 'tab-c', panes.c ?? [leaf(9)]]
  ] as const) {
    built = addWorkspace(built, key, [{ id: `group-${id}`, tabs: [{ id, leaves: [pane] }] }])
  }
  return built
}

function reload(before: WorkspaceSessionState, after: WorkspaceSessionState, written: string[]) {
  const previous = loadWholePartition(LOCAL_EXECUTION_HOST_ID, before, nameBasedLoadContext())
  const reloaded = reloadWorkspaces(
    LOCAL_EXECUTION_HOST_ID,
    previous,
    after,
    new Set(written),
    nameBasedLoadContext()
  )
  return { previous, reloaded }
}

const paneOf = (loaded: LoadedWorkspaceLayoutRead, key: string) => {
  const workspace = loaded.layout.workspaces[key]!
  const tab = workspace.tabs[0]!
  const leafId =
    tab.kind === 'terminal' && tab.panes.root?.type === 'leaf' ? tab.panes.root.leafId : ''
  return { leafId, ptyId: workspace.leaves?.[leafId]?.ptyId }
}

describe('reloadWorkspaces', () => {
  it('reloads only the written workspace and keeps every other workspace object', () => {
    const { previous, reloaded } = reload(
      session({ a: [leaf(1)], b: [leaf(2)] }),
      session({ a: [leaf(1), PTY], b: [leaf(2)] }),
      [A]
    )

    expect(reloaded?.keys).toEqual([A])
    expect(paneOf(reloaded!.load.loaded, A)).toEqual({ leafId: leaf(1), ptyId: PTY })
    expect(reloaded!.load.loaded.layout.workspaces[B]).toBe(previous.loaded.layout.workspaces[B])
  })

  it('reloads a workspace whose repeated pane id the written one releases', () => {
    const after = session({ a: [leaf(3)], b: [leaf(1), PTY] })
    const { reloaded } = reload(session({ a: [leaf(1)], b: [leaf(1), PTY] }), after, [A])

    expect(reloaded?.keys).toEqual([A, B])
    // B no longer repeats A's pane id, so it keeps its id and its terminal.
    expect(paneOf(reloaded!.load.loaded, B)).toEqual({ leafId: leaf(1), ptyId: PTY })
  })

  it('reloads a workspace whose duplicate terminal the written one releases', () => {
    const after = session({ a: [leaf(1)], b: [leaf(2), PTY] })
    const { reloaded } = reload(session({ a: [leaf(1), PTY], b: [leaf(2), PTY] }), after, [A])

    expect(reloaded?.keys).toEqual([A, B])
    expect(paneOf(reloaded!.load.loaded, B)).toEqual({ leafId: leaf(2), ptyId: PTY })
  })

  it('reloads the earlier workspace a written one starts repeating a pane id with', () => {
    const after = session({ a: [leaf(1)], b: [leaf(1)] })
    const { reloaded } = reload(session({ a: [leaf(1)], b: [leaf(2)] }), after, [B])

    expect(reloaded?.keys).toEqual([A, B])
    expect(paneOf(reloaded!.load.loaded, B).leafId).not.toBe(leaf(1))
  })

  it('loads tied workspaces in the order the write left them', () => {
    const before = session({ a: [leaf(1), PTY], b: [leaf(2), PTY] })
    // A frozen workspace is re-added after the others.
    const { [A]: rows, ...others } = before.tabsByWorktree
    const after = {
      ...session({ a: [leaf(1), PTY], b: [leaf(2), PTY] }),
      tabsByWorktree: { ...others, [A]: rows! }
    }
    const { reloaded } = reload(before, after, [B])

    expect(reloaded?.keys).toEqual([B, A])
    expect(paneOf(reloaded!.load.loaded, B)).toEqual({ leafId: leaf(2), ptyId: PTY })
    expect(paneOf(reloaded!.load.loaded, A)).toEqual({ leafId: leaf(1), ptyId: undefined })
  })

  it('refreshes partition-wide selections when a write names no workspace', () => {
    const before = session({ a: [leaf(1)], b: [leaf(2)] })
    const { previous, reloaded } = reload(before, { ...before, activeWorktreeId: B }, [])

    expect(reloaded?.keys).toEqual([])
    expect(reloaded!.load.loaded.desktopView.activeWorktreeId).toBe(B)
    expect(reloaded!.load.loaded.layout.workspaces[A]).toBe(previous.loaded.layout.workspaces[A])
  })

  it('leaves a new workspace to a whole load', () => {
    const before = session({ a: [leaf(1)], b: [leaf(2)] })
    const after = addWorkspace(session({ a: [leaf(1)], b: [leaf(2)] }), 'repo-1::/new', [
      { id: 'group-new', tabs: [{ id: 'tab-new', leaves: [[leaf(4)]] }] }
    ])

    expect(reload(before, after, ['repo-1::/new']).reloaded).toBeNull()
  })
})
