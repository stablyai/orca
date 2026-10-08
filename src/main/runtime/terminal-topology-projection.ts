import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { TerminalTab } from '../../shared/terminal-tab-types'
import type {
  TerminalTopologyLayout,
  TerminalTopologySlice,
  TerminalTopologyTabRow
} from '../../shared/terminal-topology-slice'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'

export type UnsequencedTerminalTopologySlice = Omit<TerminalTopologySlice, 'publishSeq'>

function projectTabRow(tab: TerminalTab): TerminalTopologyTabRow {
  const { launchAgent, defaultTitle, shellOverride, startupCwd, forceHostRuntime } = tab
  const { quickCommandLabel } = tab
  return {
    id: tab.id,
    ptyId: tab.ptyId,
    worktreeId: tab.worktreeId,
    createdAt: tab.createdAt,
    ...(launchAgent !== undefined ? { launchAgent } : {}),
    ...(defaultTitle !== undefined ? { defaultTitle } : {}),
    ...(shellOverride !== undefined ? { shellOverride } : {}),
    ...(startupCwd !== undefined ? { startupCwd } : {}),
    ...(forceHostRuntime !== undefined ? { forceHostRuntime } : {}),
    ...(quickCommandLabel !== undefined ? { quickCommandLabel } : {})
  }
}

/** Pure; reads only the worktree's own rows from the partition that owns it. */
export function projectTerminalTopologySlice(
  session: WorkspaceSessionState,
  hostId: ExecutionHostId,
  worktreeId: string
): UnsequencedTerminalTopologySlice {
  const tabs = (session.tabsByWorktree?.[worktreeId] ?? []).map(projectTabRow)
  const layouts: Record<string, TerminalTopologyLayout> = {}
  for (const tab of tabs) {
    const layout = session.terminalLayoutsByTabId?.[tab.id]
    if (!layout) {
      continue
    }
    layouts[tab.id] = {
      root: layout.root,
      ...(layout.ptyIdsByLeafId ? { ptyIdsByLeafId: layout.ptyIdsByLeafId } : {}),
      ...(layout.titlesByLeafId ? { titlesByLeafId: layout.titlesByLeafId } : {})
    }
  }
  const sleeping: Record<string, SleepingAgentSessionRecord> = {}
  for (const [paneKey, record] of Object.entries(session.sleepingAgentSessionsByPaneKey ?? {})) {
    if (record.worktreeId === worktreeId) {
      sleeping[paneKey] = record
    }
  }
  return {
    hostId,
    worktreeId,
    revision: session.terminalTopologyRevisionByRepoId?.[getRepoIdFromWorktreeId(worktreeId)] ?? 0,
    tabs,
    layouts,
    sleeping
  }
}

/** The slice main publishes for a worktree it no longer holds rows for. */
export function emptyTerminalTopologySlice(
  hostId: ExecutionHostId,
  worktreeId: string,
  revision: number
): UnsequencedTerminalTopologySlice {
  return { hostId, worktreeId, revision, tabs: [], layouts: {}, sleeping: {} }
}
