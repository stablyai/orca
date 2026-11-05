import {
  isFreshNonDoneAgentStatus,
  isAgentStatusFresh
} from '../../../../shared/agent-status/contracts/agent-status-freshness'

import type {
  RuntimeWorktreeAgentRow,
  RuntimeWorktreePsSummary
} from '../../../../shared/runtime-worktree-contracts'
import { mergeWorktreeSummaryStatus } from './runtime-worktree-status-projection'
import {
  resolveRuntimeWorktreeSidebarStatus,
  terminalTitleEvidenceMatchesSource
} from './runtime-worktree-sidebar-status'
import type { RuntimeWorktreePsSummaryLookup } from './runtime-worktree-summary-paths'
import type { RuntimeTerminalTitleEvidence } from './runtime-worktree-ps-activity'
import type { RuntimeWorktreeAgentSource } from './runtime-worktree-agent-source'

type OrchestrationDisplay = {
  taskTitle?: string | null
  displayName?: string | null
  parentPaneKey?: string | null
  parentTerminalHandle?: string | null
  coordinatorHandle?: string | null
}

function sourceForHandle(
  rowSources: ReadonlyMap<string, RuntimeWorktreeAgentSource>,
  handle: string | null | undefined
): RuntimeWorktreeAgentSource | undefined {
  if (!handle) {
    return undefined
  }
  for (const source of rowSources.values()) {
    if (source.terminalHandle === handle) {
      return source
    }
  }
  return undefined
}

/** The visible parent row. A stored pane that no longer matches a listed session falls back to the live terminal. */
function visibleParentPaneKey(
  source: RuntimeWorktreeAgentSource,
  orchestration: OrchestrationDisplay | undefined,
  rowSources: ReadonlyMap<string, RuntimeWorktreeAgentSource>
): string | null {
  const explicit = orchestration?.parentPaneKey
  if (explicit && explicit !== source.paneKey && rowSources.has(explicit)) {
    return explicit
  }
  const byHandle =
    sourceForHandle(rowSources, orchestration?.parentTerminalHandle) ??
    sourceForHandle(rowSources, orchestration?.coordinatorHandle)
  if (byHandle && byHandle.paneKey !== source.paneKey) {
    return byHandle.paneKey
  }
  return null
}

/** A mirrored child keeps another worktree id. A path alias of this summary still owns it. */
function rowBelongsToSummaryWorktree(
  source: RuntimeWorktreeAgentSource | undefined,
  worktreeId: string,
  getSummary: RuntimeWorktreePsSummaryLookup
): boolean {
  const ownerId = source?.worktreeId
  if (!ownerId) {
    return false
  }
  return ownerId === worktreeId || getSummary(ownerId)?.worktreeId === worktreeId
}

function mirrorCrossWorkspaceChildren(
  rowsByWorktree: Map<string, RuntimeWorktreeAgentRow[]>,
  rowSources: ReadonlyMap<string, RuntimeWorktreeAgentSource>,
  summaries: Map<string, RuntimeWorktreePsSummary>,
  getSummary: RuntimeWorktreePsSummaryLookup
): void {
  const mirrors: [string, RuntimeWorktreeAgentRow][] = []
  const rowsByPaneKey = new Map<string, RuntimeWorktreeAgentRow>()
  for (const rows of rowsByWorktree.values()) {
    for (const row of rows) {
      rowsByPaneKey.set(row.paneKey, row)
    }
  }
  for (const [worktreeId, rows] of rowsByWorktree) {
    for (const row of rows) {
      const visited = new Set<string>()
      let ancestorPaneKey = row.parentPaneKey ?? null
      while (ancestorPaneKey && !visited.has(ancestorPaneKey)) {
        visited.add(ancestorPaneKey)
        const ancestorSource = rowSources.get(ancestorPaneKey)
        const ancestorWorktreeId = ancestorSource?.worktreeId
          ? getSummary(ancestorSource.worktreeId)?.worktreeId
          : undefined
        if (
          ancestorWorktreeId &&
          ancestorWorktreeId !== worktreeId &&
          summaries.has(ancestorWorktreeId)
        ) {
          mirrors.push([ancestorWorktreeId, row])
        }
        ancestorPaneKey = rowsByPaneKey.get(ancestorPaneKey)?.parentPaneKey ?? null
      }
    }
  }
  for (const [parentWorktreeId, row] of mirrors) {
    const parentRows = rowsByWorktree.get(parentWorktreeId) ?? []
    if (parentRows.some((existing) => existing.paneKey === row.paneKey)) {
      continue
    }
    parentRows.push(row)
    rowsByWorktree.set(parentWorktreeId, parentRows)
  }
}

export function attachRuntimeWorktreeAgentRows(args: {
  summaries: Map<string, RuntimeWorktreePsSummary>
  rowSources: ReadonlyMap<string, RuntimeWorktreeAgentSource>
  terminalTitleEvidenceByWorktreeId: ReadonlyMap<string, readonly RuntimeTerminalTitleEvidence[]>
  orchestrationByPaneKey: Record<string, OrchestrationDisplay> | null | undefined
  getSummary: RuntimeWorktreePsSummaryLookup
  conversationName?: (source: RuntimeWorktreeAgentSource) => string | null
}): void {
  const { rowSources } = args
  const now = Date.now()
  const rowsByWorktree = new Map<string, RuntimeWorktreeAgentRow[]>()
  for (const source of rowSources.values()) {
    const { worktreeId } = source
    if (!worktreeId) {
      continue
    }
    const summary = args.getSummary(worktreeId)
    if (!summary) {
      continue
    }
    const orchestration = args.orchestrationByPaneKey?.[source.paneKey]
    const parentPaneKey = visibleParentPaneKey(source, orchestration, rowSources)
    // Like desktop lineage, a listed child running in its parent's tab does not own that tab's name.
    const parent = parentPaneKey ? rowSources.get(parentPaneKey) : undefined
    const conversationName =
      parent && parent.tabId === source.tabId ? null : args.conversationName?.(source)
    const row: RuntimeWorktreeAgentRow = {
      paneKey: source.paneKey,
      parentPaneKey,
      homeWorktreeId: summary.worktreeId,
      ...(summary.hostId ? { homeHostId: summary.hostId } : {}),
      state: source.state,
      ...(source.workingMode ? { workingMode: source.workingMode } : {}),
      agentType: source.agentType,
      prompt: source.prompt,
      taskTitle: orchestration?.taskTitle ?? null,
      displayName: orchestration?.displayName ?? null,
      ...(conversationName ? { conversationName } : {}),
      lastAssistantMessage: source.lastAssistantMessage,
      toolName: source.toolName,
      toolInput: source.toolInput,
      interrupted: source.interrupted,
      ...(source.mainAgent ? { mainAgent: source.mainAgent } : {}),
      stateStartedAt: source.stateStartedAt,
      updatedAt: source.updatedAt,
      ...(source.children !== undefined ? { children: source.children } : {}),
      ...(source.subagents !== undefined ? { subagents: source.subagents } : {}),
      ...(source.structuredHost === 'owned' ? { structuredHostOwned: true as const } : {}),
      ...(source.hasLivePty ? { hasLivePty: true as const } : {}),
      ...(source.programStatus ? { programStatus: source.programStatus } : {})
    }
    if (source.children !== undefined || source.subagents !== undefined) {
      row.subagentObservation = isAgentStatusFresh(row, now) ? 'live' : 'unverifiable'
    }
    const rows = rowsByWorktree.get(summary.worktreeId)
    if (rows) {
      rows.push(row)
    } else {
      rowsByWorktree.set(summary.worktreeId, [row])
    }
  }
  mirrorCrossWorkspaceChildren(rowsByWorktree, rowSources, args.summaries, args.getSummary)
  for (const [worktreeId, rows] of rowsByWorktree) {
    rows.sort((a, b) => a.stateStartedAt - b.stateStartedAt)
    const summary = args.summaries.get(worktreeId)
    if (!summary) {
      continue
    }
    summary.agents = rows
    let hasForegroundWorkingAgent = false
    const monitoringSources: RuntimeWorktreeAgentSource[] = []
    for (const row of rows) {
      // A child mirrored onto its coordinator's workspace must not mark that workspace busy.
      if (!rowBelongsToSummaryWorktree(rowSources.get(row.paneKey), worktreeId, args.getSummary)) {
        continue
      }
      if (!isFreshNonDoneAgentStatus(row, now)) {
        continue
      }
      summary.hasHostSidebarActivity = true
      if (row.state === 'working') {
        if (row.workingMode === 'monitoring') {
          const source = rowSources.get(row.paneKey)
          if (source) {
            monitoringSources.push(source)
          }
        } else {
          hasForegroundWorkingAgent = true
        }
      } else {
        mergeWorktreeSummaryStatus(summary, 'permission')
      }
    }
    if (hasForegroundWorkingAgent || monitoringSources.length > 0) {
      const hasIndependentWorkingTerminal = (
        args.terminalTitleEvidenceByWorktreeId.get(worktreeId) ?? []
      ).some(
        (evidence) =>
          evidence.status === 'working' &&
          monitoringSources.every((source) => !terminalTitleEvidenceMatchesSource(evidence, source))
      )
      mergeWorktreeSummaryStatus(
        summary,
        'working',
        hasForegroundWorkingAgent || hasIndependentWorkingTerminal ? undefined : 'monitoring'
      )
    }
  }
  for (const summary of args.summaries.values()) {
    summary.sidebarStatus = resolveRuntimeWorktreeSidebarStatus(
      summary,
      now,
      args.terminalTitleEvidenceByWorktreeId.get(summary.worktreeId) ?? [],
      (paneKey) => rowSources.get(paneKey),
      (paneKey) =>
        rowBelongsToSummaryWorktree(rowSources.get(paneKey), summary.worktreeId, args.getSummary)
    )
  }
}
