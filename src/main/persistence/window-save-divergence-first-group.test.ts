// A layout-owner build's window saving a workspace before main's frame with its first tab arrives:
// the save carries none of that workspace's tab-bar records, so the Loader rebuilds the tab from
// its row in a group it names. Main names its first group the same way, so nothing changed.

import { describe, expect, it, vi } from 'vitest'
import {
  asLoaded,
  build,
  testContext,
  WS
} from '../../shared/workspace-layout/workspace-layout-command.test-fixture'
import { saveWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-save'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { layoutModelOf, windowSaveDivergences } from './window-save-divergence'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

function withoutTabBar(session: WorkspaceSessionState, key: string): WorkspaceSessionState {
  const drop = <T>(records: Record<string, T> | undefined) =>
    Object.fromEntries(Object.entries(records ?? {}).filter(([id]) => id !== key))
  return {
    ...session,
    unifiedTabs: drop(session.unifiedTabs),
    tabGroups: drop(session.tabGroups),
    tabGroupLayouts: drop(session.tabGroupLayouts),
    activeGroupIdByWorktree: drop(session.activeGroupIdByWorktree)
  }
}

describe('a window save that predates main’s first tab of a workspace', () => {
  it('leaves main’s group and group tree as they are', () => {
    const { model } = build(testContext(), [
      { type: 'createTerminalTab', workspace: WS, initial: 'activation' }
    ])
    const mains = saveWorkspaceLayout(asLoaded(model))
    const windows = withoutTabBar(mains, WS)

    const was = layoutModelOf(mains, LOCAL_EXECUTION_HOST_ID)
    const now = layoutModelOf(windows, LOCAL_EXECUTION_HOST_ID)

    expect(now?.workspaces[WS]?.tabs.map((tab) => tab.id)).toEqual(
      was?.workspaces[WS]?.tabs.map((tab) => tab.id)
    )
    expect(windowSaveDivergences(was, now)).toEqual([])
  })
})
