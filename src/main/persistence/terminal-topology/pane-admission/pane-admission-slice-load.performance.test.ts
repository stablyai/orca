// Perf contract: admitting one pane loaded every workspace in the partition, so each terminal create at about 1,900 workspaces blocked main for tens of milliseconds (hundreds on Windows).

import { expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/orca-profiles/constants'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import type * as WorkspaceLoad from '../../../../shared/workspace-layout/persistence/workspace-layout-load-workspace'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { admitPaneToSession } from './terminal-pane-admission'

const work = vi.hoisted(() => ({ loads: 0 }))

vi.mock(
  '../../../../shared/workspace-layout/persistence/workspace-layout-load-workspace',
  async (importOriginal) => {
    const actual = await importOriginal<typeof WorkspaceLoad>()
    return {
      ...actual,
      loadWorkspace: (...args: Parameters<typeof actual.loadWorkspace>) => {
        work.loads++
        return actual.loadWorkspace(...args)
      }
    }
  }
)

const key = (n: number): string => `repo-1::/fleet/w${n}`
const leaf = (n: number): string => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`

function fleet(workspaces: number): WorkspaceSessionState {
  const session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    unifiedTabs: {},
    tabGroups: {},
    tabGroupLayouts: {}
  }
  for (let n = 0; n < workspaces; n++) {
    const tabId = `t${n}`
    session.tabsByWorktree[key(n)] = [
      {
        id: tabId,
        ptyId: null,
        worktreeId: key(n),
        title: tabId,
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ]
    session.terminalLayoutsByTabId[tabId] = {
      root: { type: 'leaf', leafId: leaf(n) },
      activeLeafId: leaf(n),
      expandedLeafId: null
    }
    session.tabGroups![key(n)] = [
      { id: `g${n}`, worktreeId: key(n), activeTabId: tabId, tabOrder: [tabId] }
    ]
  }
  return session
}

it.each([200, 2_000])('admits a pane by loading one workspace of %i', (workspaces) => {
  const session = fleet(workspaces)
  work.loads = 0

  const change = admitPaneToSession(LOCAL_EXECUTION_HOST_ID, session, {
    type: 'createTerminalTab',
    workspace: key(7),
    tabId: 'new-tab',
    leafId: leaf(workspaces + 1)
  })

  expect(change.value).toBe('admitted')
  expect(work.loads).toBe(1)
})
