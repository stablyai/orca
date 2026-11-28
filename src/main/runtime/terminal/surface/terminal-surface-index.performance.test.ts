import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/orca-profiles/constants'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { loadWorkspaceLayoutWithoutReport } from '../../../../shared/workspace-layout/persistence/workspace-layout-load'
import { nameBasedLoadContext } from '../../../../shared/workspace-layout/persistence/workspace-layout-minted-ids'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import type { WorkspaceLayoutReads } from './workspace-layout-stream'
import { TerminalSurfaceIndex } from './terminal-surface-index'

// Layout-owner census, performance row: every layout write re-projects main's terminal surfaces
// (3.5 ms p50, 5.4 ms p95 per write at 1,900 workspaces). The work must stay one routing read per
// workspace per write, and none for a read with no write, or a long-used profile stalls main.

const WORKSPACES = 1_900
const TABS_PER_WORKSPACE = 2

const key = (n: number): string => `repo-1::/fleet/w${n}`
const leafId = (n: number, t: number): string =>
  `${n.toString(16).padStart(8, '0')}-000${t}-4000-8000-000000000000`

function fleetSession(): WorkspaceSessionState {
  const session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    unifiedTabs: {},
    tabGroups: {},
    tabGroupLayouts: {}
  }
  for (let n = 0; n < WORKSPACES; n++) {
    const tabIds: string[] = []
    session.tabsByWorktree[key(n)] = []
    for (let t = 0; t < TABS_PER_WORKSPACE; t++) {
      const tabId = `t${n}-${t}`
      tabIds.push(tabId)
      session.tabsByWorktree[key(n)].push({
        id: tabId,
        ptyId: `pty-${n}-${t}`,
        worktreeId: key(n),
        title: tabId,
        customTitle: null,
        color: null,
        sortOrder: t,
        createdAt: 1
      })
      session.terminalLayoutsByTabId[tabId] = {
        root: { type: 'leaf', leafId: leafId(n, t) },
        activeLeafId: leafId(n, t),
        expandedLeafId: null,
        ptyIdsByLeafId: { [leafId(n, t)]: `pty-${n}-${t}` }
      }
    }
    session.tabGroups![key(n)] = [
      { id: `g${n}`, worktreeId: key(n), activeTabId: tabIds[0], tabOrder: tabIds }
    ]
  }
  return session
}

describe('TerminalSurfaceIndex at 1,900 workspaces', () => {
  it('reads routing once per workspace per layout write, and not at all with no write', () => {
    const loaded = loadWorkspaceLayoutWithoutReport(
      LOCAL_EXECUTION_HOST_ID,
      fleetSession(),
      nameBasedLoadContext()
    )
    let partition = { layout: loaded.layout, desktopView: loaded.desktopView, facts: loaded.facts }
    let routingReads = 0
    const reads = {
      readPartition: () => partition,
      onLayoutOperationCommitted: () => () => {}
    } as unknown as WorkspaceLayoutReads
    const index = new TerminalSurfaceIndex({
      reads: () => reads,
      hostIds: () => [LOCAL_EXECUTION_HOST_ID],
      homeHostId: () => {
        routingReads += 1
        return LOCAL_EXECUTION_HOST_ID
      },
      generatedTitlesEnabled: () => false,
      onChanged: () => {}
    })

    expect(index.surfaces().leaves).toHaveLength(WORKSPACES * TABS_PER_WORKSPACE)

    for (let write = 0; write < 5; write++) {
      // A layout write replaces the partition object, as the projection does after any commit.
      partition = {
        ...partition,
        layout: { ...partition.layout, workspaces: { ...partition.layout.workspaces } }
      }
      routingReads = 0
      index.surfaces()
      expect(routingReads).toBe(WORKSPACES)
    }

    routingReads = 0
    for (let read = 0; read < 20; read++) {
      index.surfaces()
    }
    expect(routingReads).toBe(0)
  })
})
