import { borrowWorkspaceSession } from '../../../persistence/loading-store/workspace-sessions/session-host-partitions'
import type { RuntimeSyncedTab } from '../../../../shared/runtime-session-contracts'
import type { RuntimeWorktreePsSummary } from '../../../../shared/runtime-worktree-contracts'
import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { getWorkspaceSessionTabActivityIds } from '../../../../shared/workspace-session/workspace-session-tab-activity'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../terminal/records/runtime-terminal-state-records'
import {
  connectionEvidenceHostId,
  type RuntimeWorktreePsSummaryLookup
} from './runtime-worktree-summary-paths'
import {
  getLatestPtyTitle,
  getLeafDisplayRecord,
  getLeafWorktreeStatus,
  getPtyDisplayRecord,
  getSavedTabWorktreeStatus,
  maxTimestamp,
  mergeWorktreeSummaryStatus,
  type TitleDisplayClear
} from './runtime-worktree-status-projection'
import { worktreeIdsEqual } from '../../../../shared/worktree/id'
import type { PtyPaneOf } from '../../terminal/surface/pty-pane-query'

/** A live terminal whose title reads working or needs-permission, kept per pane so agent rows can suppress it. */
export type RuntimeTerminalTitleEvidence = {
  status: 'working' | 'permission'
  paneKey: string | null
  ptyId: string | null
  tabId: string | null
}

export function applyRuntimeWorktreePsTerminalActivity(args: {
  freshPtyLiveness: ReadonlySet<string> | null
  /** Filled with every PTY this pass counts as live. */
  countedPtyIds: Set<string>
  leaves: Iterable<RuntimeLeafRecord>
  ptysById: ReadonlyMap<string, RuntimePtyWorktreeRecord>
  tabs: ReadonlyMap<string, RuntimeSyncedTab>
  session: WorkspaceSessionState | null | undefined
  getPaneKey: (leaf: RuntimeLeafRecord) => string
  paneOf: PtyPaneOf
  getTitleDisplayClear: (ptyId: string) => TitleDisplayClear | null
  getSummary: RuntimeWorktreePsSummaryLookup
}): Map<RuntimeWorktreePsSummary, RuntimeTerminalTitleEvidence[]> {
  const titleEvidence = new Map<RuntimeWorktreePsSummary, RuntimeTerminalTitleEvidence[]>()
  const savedTabOwnerById = new Map<string, { worktreeId: string; title: string }>()
  for (const [worktreeId, tabs] of Object.entries(args.session?.tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      savedTabOwnerById.set(tab.id, { worktreeId, title: tab.title })
    }
  }
  const savedLayoutTabIdByPtyId = new Map<string, string>()
  for (const [tabId, layout] of Object.entries(args.session?.terminalLayoutsByTabId ?? {})) {
    for (const ptyId of Object.values(layout?.ptyIdsByLeafId ?? {})) {
      if (ptyId) {
        savedLayoutTabIdByPtyId.set(ptyId, tabId)
      }
    }
  }
  const countedPtyIds = args.countedPtyIds
  for (const leaf of args.leaves) {
    if (
      !leaf.ptyId ||
      !leaf.connected ||
      (args.freshPtyLiveness !== null && !args.freshPtyLiveness.has(leaf.ptyId))
    ) {
      continue
    }
    const freshOwner = args.ptysById.get(leaf.ptyId)
    if (
      args.freshPtyLiveness !== null &&
      freshOwner?.connected &&
      !worktreeIdsEqual(freshOwner.worktreeId, leaf.worktreeId)
    ) {
      continue
    }
    const summary = args.getSummary(leaf.worktreeId, ptyRecordHostId(freshOwner))
    if (!summary) {
      continue
    }
    countedPtyIds.add(leaf.ptyId)
    summary.hasHostSidebarActivity = true
    const previousLastOutputAt = summary.lastOutputAt
    summary.liveTerminalCount += 1
    summary.hasAttachedPty = true
    summary.lastOutputAt = maxTimestamp(summary.lastOutputAt, leaf.lastOutputAt)
    const leafStatus = getLeafWorktreeStatus(
      getLeafDisplayRecord(leaf, args.getTitleDisplayClear(leaf.ptyId)),
      args.tabs.get(leaf.tabId)?.title ?? null
    )
    if (leafStatus === 'working' || leafStatus === 'permission') {
      addTerminalTitleEvidence(titleEvidence, summary, {
        status: leafStatus,
        paneKey: args.getPaneKey(leaf),
        ptyId: leaf.ptyId,
        tabId: leaf.tabId
      })
    }
    mergeWorktreeSummaryStatus(summary, leafStatus)
    if (
      leaf.preview &&
      (summary.preview.length === 0 || (leaf.lastOutputAt ?? -1) >= (previousLastOutputAt ?? -1))
    ) {
      summary.preview = leaf.preview
    }
  }
  for (const pty of args.ptysById.values()) {
    if (
      !pty.connected ||
      countedPtyIds.has(pty.ptyId) ||
      (args.freshPtyLiveness !== null && !args.freshPtyLiveness.has(pty.ptyId))
    ) {
      continue
    }
    const persistedTabId = savedLayoutTabIdByPtyId.get(pty.ptyId)
    const displayTitle = getLatestPtyTitle(
      getPtyDisplayRecord(pty, args.getTitleDisplayClear(pty.ptyId))
    )
    let owner = persistedTabId ? savedTabOwnerById.get(persistedTabId) : undefined
    if (args.freshPtyLiveness !== null) {
      owner = { worktreeId: pty.worktreeId, title: owner?.title ?? displayTitle ?? '' }
    }
    const recorded = args.paneOf(pty)
    if (!owner && persistedTabId && recorded.tabId === persistedTabId) {
      owner = { worktreeId: pty.worktreeId, title: displayTitle ?? '' }
    }
    const pane = parsePaneKey(recorded.paneKey ?? '')
    const hasExplicitOwner =
      recorded.tabId !== null && pane?.tabId === recorded.tabId && pane.leafId.length > 0
    const savedOwner = recorded.tabId ? savedTabOwnerById.get(recorded.tabId) : undefined
    const hasSavedLayout =
      recorded.tabId !== null &&
      Object.hasOwn(args.session?.terminalLayoutsByTabId ?? {}, recorded.tabId)
    if (!owner && hasExplicitOwner && !hasSavedLayout) {
      owner = {
        worktreeId: savedOwner?.worktreeId ?? pty.worktreeId,
        title: savedOwner?.title ?? displayTitle ?? ''
      }
    }
    if (!owner) {
      continue
    }
    const summary = args.getSummary(owner.worktreeId, ptyRecordHostId(pty))
    if (!summary) {
      continue
    }
    countedPtyIds.add(pty.ptyId)
    const previousLastOutputAt = summary.lastOutputAt
    summary.liveTerminalCount += 1
    summary.hasAttachedPty = true
    summary.hasHostSidebarActivity = true
    summary.lastOutputAt = maxTimestamp(summary.lastOutputAt, pty.lastOutputAt)
    const ptyStatus = getSavedTabWorktreeStatus(owner.title, true)
    if (ptyStatus === 'working' || ptyStatus === 'permission') {
      addTerminalTitleEvidence(titleEvidence, summary, {
        status: ptyStatus,
        paneKey: recorded.paneKey,
        ptyId: pty.ptyId,
        tabId: recorded.tabId ?? persistedTabId ?? null
      })
    }
    mergeWorktreeSummaryStatus(summary, ptyStatus)
    if (
      pty.preview &&
      (summary.preview.length === 0 || (pty.lastOutputAt ?? -1) >= (previousLastOutputAt ?? -1))
    ) {
      summary.preview = pty.preview
    }
  }
  return titleEvidence
}

function addTerminalTitleEvidence(
  evidenceByRow: Map<RuntimeWorktreePsSummary, RuntimeTerminalTitleEvidence[]>,
  summary: RuntimeWorktreePsSummary,
  evidence: RuntimeTerminalTitleEvidence
): void {
  const existing = evidenceByRow.get(summary)
  if (existing) {
    existing.push(evidence)
  } else {
    evidenceByRow.set(summary, [evidence])
  }
}

/** The host a PTY record proves: its SSH connection, else this Orca. A missing record proves none. */
export function ptyRecordHostId(
  pty: Pick<RuntimePtyWorktreeRecord, 'connectionId'> | undefined
): ExecutionHostId | undefined {
  return pty ? connectionEvidenceHostId(pty.connectionId) : undefined
}

export function applyRuntimeWorktreePsSessionActivity(args: {
  store: RuntimeStore | null
  summaries: Map<string, RuntimeWorktreePsSummary>
  repoById: ReadonlyMap<string, Repo>
  ptysById: ReadonlyMap<string, RuntimePtyWorktreeRecord>
  tabs: ReadonlyMap<string, RuntimeSyncedTab>
  paneOf: PtyPaneOf
  /** Non-minting: a listing must not issue handles, only recognise the ones already bound. */
  getTerminalHandlesForPty: (ptyId: string) => readonly string[]
  getSummary: RuntimeWorktreePsSummaryLookup
}): {
  mirroredWorktreeIdByTabId: Map<string, string>
  connectedPtyEvidence: {
    tabIds: Set<string>
    paneKeys: Set<string>
    ptyIdByTerminalHandle: Map<string, string>
  }
} {
  const mirroredWorktreeIdByTabId = new Map<string, string>()
  const sessionsByHostId = new Map<ExecutionHostId, WorkspaceSessionState>()
  for (const summary of args.summaries.values()) {
    const repo = args.repoById.get(summary.repoId)
    // Same-id repos on two hosts share one repoById entry; the row's own host names its session.
    const hostId = summary.hostId ?? (repo ? getRepoExecutionHostId(repo) : 'local')
    const session = borrowWorkspaceSession(args.store, hostId)
    if (session) {
      sessionsByHostId.set(hostId, session)
    }
  }
  // Each host's session names that host's copy of a same-id workspace.
  for (const [hostId, session] of sessionsByHostId) {
    const getSummary = (worktreeId: string) => args.getSummary(worktreeId, hostId)
    for (const [worktreeId, tabs] of Object.entries(session.tabsByWorktree ?? {})) {
      for (const tab of tabs) {
        mirroredWorktreeIdByTabId.set(tab.id, worktreeId)
      }
      if (tabs.length === 0) {
        continue
      }
      const summary = getSummary(worktreeId)
      if (summary && tabs.some((tab) => tab.ptyId && args.ptysById.get(tab.ptyId)?.connected)) {
        summary.hasHostSidebarActivity = true
      }
    }
    for (const worktreeId of getWorkspaceSessionTabActivityIds(session)) {
      const summary = getSummary(worktreeId)
      if (summary) {
        summary.hasHostSidebarActivity = true
      }
    }
    if (session.activeWorktreeId) {
      const summary = getSummary(session.activeWorktreeId)
      if (summary) {
        summary.isActive = true
      }
    }
  }
  for (const [tabId, tab] of args.tabs) {
    if (!mirroredWorktreeIdByTabId.has(tabId)) {
      mirroredWorktreeIdByTabId.set(tabId, tab.worktreeId)
    }
  }
  const connectedPtyEvidence = {
    tabIds: new Set<string>(),
    paneKeys: new Set<string>(),
    ptyIdByTerminalHandle: new Map<string, string>()
  }
  for (const pty of args.ptysById.values()) {
    if (!pty.connected) {
      continue
    }
    const { tabId, paneKey } = args.paneOf(pty)
    if (tabId) {
      connectedPtyEvidence.tabIds.add(tabId)
    }
    if (paneKey) {
      connectedPtyEvidence.paneKeys.add(paneKey)
    }
    for (const terminalHandle of args.getTerminalHandlesForPty(pty.ptyId)) {
      connectedPtyEvidence.ptyIdByTerminalHandle.set(terminalHandle, pty.ptyId)
    }
  }
  return { mirroredWorktreeIdByTabId, connectedPtyEvidence }
}
