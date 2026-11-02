import { isFreshNonDoneAgentStatus } from '../../shared/agent-status-types'
import { isAgentStatusFresh } from '../../shared/agent-status-freshness'
import type { RuntimeWorktreeAgentRow, RuntimeWorktreePsSummary } from '../../shared/runtime-types'
import { mergeWorktreeSummaryStatus } from './runtime-worktree-status-projection'
import {
  resolveRuntimeWorktreeSidebarStatus,
  terminalTitleEvidenceMatchesSource
} from './runtime-worktree-sidebar-status'
import type { RuntimeWorktreePsSummaryLookup } from './runtime-worktree-summary-paths'
import type { RuntimeTerminalTitleEvidence } from './runtime-worktree-ps-activity'
import type { RuntimeWorktreeAgentSource } from './runtime-worktree-agent-source'
export type { RuntimeAgentRowSnapshot } from './runtime-hook-agent-row-selection'

type OrchestrationDisplay = {
  taskTitle?: string | null
  displayName?: string | null
  parentPaneKey?: string | null
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
    const parentPaneKey = orchestration?.parentPaneKey ?? null
    // Like desktop lineage, a listed child running in its parent's tab does not own that tab's name.
    const parent = parentPaneKey ? rowSources.get(parentPaneKey) : undefined
    const conversationName =
      parent && parent.tabId === source.tabId ? null : args.conversationName?.(source)
    const row: RuntimeWorktreeAgentRow = {
      paneKey: source.paneKey,
      parentPaneKey,
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
      (paneKey) => rowSources.get(paneKey)
    )
  }
}
