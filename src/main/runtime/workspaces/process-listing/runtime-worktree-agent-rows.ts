import {
  isFreshNonDoneAgentStatus,
  isAgentStatusFresh
} from '../../../../shared/agent-status/contracts/agent-status-freshness'

import type {
  RuntimeWorktreeAgentRow,
  RuntimeWorktreePsSummary
} from '../../../../shared/runtime-worktree-contracts'
import type {
  AgentListPublication,
  AgentListVerdict
} from '../../../../shared/agent-status/presentation/agent-list-status'
import { mergeWorktreeSummaryStatus } from './runtime-worktree-status-projection'
import {
  resolveRuntimeWorktreeSidebarStatus,
  terminalTitleEvidenceMatchesSource
} from './runtime-worktree-sidebar-status'
import {
  connectionEvidenceHostId,
  type RuntimeWorktreePsSummaryLookup
} from './runtime-worktree-summary-paths'
import type { RuntimeTerminalTitleEvidence } from './runtime-worktree-ps-activity'
import type { RuntimeWorktreeAgentSource } from './runtime-worktree-agent-source'

type OrchestrationDisplay = {
  taskTitle?: string | null
  displayName?: string | null
  parentPaneKey?: string | null
}

const UNLISTED: AgentListVerdict = { listed: false }

/** A pane the window gave no verdict is not in its list, unless it changed after the window last looked. */
function agentListVerdict(
  agentList: AgentListPublication,
  source: RuntimeWorktreeAgentSource
): AgentListVerdict | undefined {
  return (
    agentList.verdicts[source.paneKey] ??
    (source.updatedAt > agentList.publishedAt ? undefined : UNLISTED)
  )
}

export function attachRuntimeWorktreeAgentRows(args: {
  summaries: Map<string, RuntimeWorktreePsSummary>
  rowSources: ReadonlyMap<string, RuntimeWorktreeAgentSource>
  terminalTitleEvidenceByRow: ReadonlyMap<
    RuntimeWorktreePsSummary,
    readonly RuntimeTerminalTitleEvidence[]
  >
  orchestrationByPaneKey: Record<string, OrchestrationDisplay> | null | undefined
  getSummary: RuntimeWorktreePsSummaryLookup
  conversationName?: (source: RuntimeWorktreeAgentSource) => string | null
  /** The desktop window's Agents-list verdicts; null when no window has published them. */
  agentList?: AgentListPublication | null
}): void {
  const { rowSources } = args
  const now = Date.now()
  const rowsBySummary = new Map<RuntimeWorktreePsSummary, RuntimeWorktreeAgentRow[]>()
  for (const source of rowSources.values()) {
    const { worktreeId } = source
    if (!worktreeId) {
      continue
    }
    const summary = args.getSummary(worktreeId, connectionEvidenceHostId(source.connectionId))
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
    const activity = args.agentList && agentListVerdict(args.agentList, source)
    if (activity) {
      row.activity = activity
    }
    const rows = rowsBySummary.get(summary)
    if (rows) {
      rows.push(row)
    } else {
      rowsBySummary.set(summary, [row])
    }
  }
  for (const [summary, rows] of rowsBySummary) {
    rows.sort((a, b) => a.stateStartedAt - b.stateStartedAt)
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
        args.terminalTitleEvidenceByRow.get(summary) ?? []
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
      args.terminalTitleEvidenceByRow.get(summary) ?? [],
      (paneKey) => rowSources.get(paneKey)
    )
  }
}
