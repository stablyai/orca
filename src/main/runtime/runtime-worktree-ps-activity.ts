import type { RuntimeSyncedTab, RuntimeWorktreePsSummary } from '../../shared/runtime-types'
import type { Repo } from '../../shared/repo-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { RuntimeStore } from './runtime-store-contract'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { RuntimeWorktreeSummaryPathIndex } from './runtime-worktree-summary-paths'
import {
  getLatestPtyTitle,
  getLeafWorktreeStatus,
  getSavedTabWorktreeStatus,
  maxTimestamp,
  mergeWorktreeSummaryStatus
} from './runtime-worktree-status-projection'
import { runtimeWorktreeIdsEqual } from './runtime-worktree-path-identity'

type SummaryLookup = (
  summaries: Map<string, RuntimeWorktreePsSummary>,
  pathIndex: RuntimeWorktreeSummaryPathIndex,
  missingIds: Set<string>,
  worktreeId: string
) => RuntimeWorktreePsSummary | null

export type RuntimeWorkingTerminalEvidence = {
  paneKey: string | null
  ptyId: string | null
  tabId: string | null
}

export function applyRuntimeWorktreePsTerminalActivity(args: {
  summaries: Map<string, RuntimeWorktreePsSummary>
  pathIndex: RuntimeWorktreeSummaryPathIndex
  missingIds: Set<string>
  freshPtyLiveness: ReadonlySet<string> | null
  leaves: Iterable<RuntimeLeafRecord>
  ptysById: ReadonlyMap<string, RuntimePtyWorktreeRecord>
  tabs: ReadonlyMap<string, RuntimeSyncedTab>
  session: WorkspaceSessionState | null | undefined
  getPaneKey: (leaf: RuntimeLeafRecord) => string
  getSummary: SummaryLookup
}): Map<string, RuntimeWorkingTerminalEvidence[]> {
  const workingEvidence = new Map<string, RuntimeWorkingTerminalEvidence[]>()
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
  const countedPtyIds = new Set<string>()
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
      !runtimeWorktreeIdsEqual(freshOwner.worktreeId, leaf.worktreeId)
    ) {
      continue
    }
    const summary = args.getSummary(
      args.summaries,
      args.pathIndex,
      args.missingIds,
      leaf.worktreeId
    )
    if (!summary) {
      continue
    }
    countedPtyIds.add(leaf.ptyId)
    summary.hasHostSidebarActivity = true
    const previousLastOutputAt = summary.lastOutputAt
    summary.liveTerminalCount += 1
    summary.hasAttachedPty = true
    summary.lastOutputAt = maxTimestamp(summary.lastOutputAt, leaf.lastOutputAt)
    const leafStatus = getLeafWorktreeStatus(leaf, args.tabs.get(leaf.tabId)?.title ?? null)
    if (leafStatus === 'working') {
      addWorkingTerminalEvidence(workingEvidence, summary.worktreeId, {
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
    let owner = persistedTabId ? savedTabOwnerById.get(persistedTabId) : undefined
    if (args.freshPtyLiveness !== null) {
      owner = { worktreeId: pty.worktreeId, title: owner?.title ?? getLatestPtyTitle(pty) ?? '' }
    }
    if (!owner && persistedTabId && pty.tabId === persistedTabId) {
      owner = { worktreeId: pty.worktreeId, title: getLatestPtyTitle(pty) ?? '' }
    }
    const pane = parsePaneKey(pty.paneKey ?? '')
    const hasExplicitOwner =
      pty.tabId !== null && pane?.tabId === pty.tabId && pane.leafId.length > 0
    const savedOwner = pty.tabId ? savedTabOwnerById.get(pty.tabId) : undefined
    const hasSavedLayout =
      pty.tabId !== null && Object.hasOwn(args.session?.terminalLayoutsByTabId ?? {}, pty.tabId)
    if (!owner && hasExplicitOwner && !hasSavedLayout) {
      owner = {
        worktreeId: savedOwner?.worktreeId ?? pty.worktreeId,
        title: savedOwner?.title ?? getLatestPtyTitle(pty) ?? ''
      }
    }
    if (!owner) {
      continue
    }
    const summary = args.getSummary(
      args.summaries,
      args.pathIndex,
      args.missingIds,
      owner.worktreeId
    )
    if (!summary) {
      continue
    }
    const previousLastOutputAt = summary.lastOutputAt
    summary.liveTerminalCount += 1
    summary.hasAttachedPty = true
    summary.hasHostSidebarActivity = true
    summary.lastOutputAt = maxTimestamp(summary.lastOutputAt, pty.lastOutputAt)
    const ptyStatus = getSavedTabWorktreeStatus(owner.title, true)
    if (ptyStatus === 'working') {
      addWorkingTerminalEvidence(workingEvidence, summary.worktreeId, {
        paneKey: pty.paneKey,
        ptyId: pty.ptyId,
        tabId: pty.tabId ?? persistedTabId ?? null
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
  return workingEvidence
}

function addWorkingTerminalEvidence(
  evidenceByWorktreeId: Map<string, RuntimeWorkingTerminalEvidence[]>,
  worktreeId: string,
  evidence: RuntimeWorkingTerminalEvidence
): void {
  const existing = evidenceByWorktreeId.get(worktreeId)
  if (existing) {
    existing.push(evidence)
  } else {
    evidenceByWorktreeId.set(worktreeId, [evidence])
  }
}

export function applyRuntimeWorktreePsSessionActivity(args: {
  store: RuntimeStore | null
  summaries: Map<string, RuntimeWorktreePsSummary>
  repoById: ReadonlyMap<string, Repo>
  pathIndex: RuntimeWorktreeSummaryPathIndex
  missingIds: Set<string>
  ptysById: ReadonlyMap<string, RuntimePtyWorktreeRecord>
  tabs: ReadonlyMap<string, RuntimeSyncedTab>
  getSummary: SummaryLookup
}): {
  mirroredWorktreeIdByTabId: Map<string, string>
  connectedPtyEvidence: { tabIds: Set<string>; paneKeys: Set<string>; ptyIds: Set<string> }
} {
  const mirroredWorktreeIdByTabId = new Map<string, string>()
  const sessionsByHostId = new Map<ExecutionHostId, WorkspaceSessionState>()
  for (const summary of args.summaries.values()) {
    const repo = args.repoById.get(summary.repoId)
    const session = args.store?.getWorkspaceSession?.(repo ? getRepoExecutionHostId(repo) : 'local')
    if (session) {
      sessionsByHostId.set(repo ? getRepoExecutionHostId(repo) : 'local', session)
    }
  }
  for (const session of sessionsByHostId.values()) {
    for (const [worktreeId, tabs] of Object.entries(session.tabsByWorktree ?? {})) {
      for (const tab of tabs) {
        mirroredWorktreeIdByTabId.set(tab.id, worktreeId)
      }
      if (tabs.length === 0) {
        continue
      }
      const summary = args.getSummary(args.summaries, args.pathIndex, args.missingIds, worktreeId)
      if (summary && tabs.some((tab) => tab.ptyId && args.ptysById.get(tab.ptyId)?.connected)) {
        summary.hasHostSidebarActivity = true
      }
    }
    for (const [worktreeId, tabs] of Object.entries(session.browserTabsByWorktree ?? {})) {
      if (tabs.length === 0) {
        continue
      }
      const summary = args.getSummary(args.summaries, args.pathIndex, args.missingIds, worktreeId)
      if (summary) {
        summary.hasHostSidebarActivity = true
      }
    }
    if (session.activeWorktreeId) {
      const summary = args.getSummary(
        args.summaries,
        args.pathIndex,
        args.missingIds,
        session.activeWorktreeId
      )
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
    ptyIds: new Set<string>()
  }
  for (const pty of args.ptysById.values()) {
    if (!pty.connected) {
      continue
    }
    connectedPtyEvidence.ptyIds.add(pty.ptyId)
    if (pty.tabId) {
      connectedPtyEvidence.tabIds.add(pty.tabId)
    }
    if (pty.paneKey) {
      connectedPtyEvidence.paneKeys.add(pty.paneKey)
    }
  }
  return { mirroredWorktreeIdByTabId, connectedPtyEvidence }
}
