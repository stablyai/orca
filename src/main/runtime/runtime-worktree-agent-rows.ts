import { isFreshNonDoneAgentStatus } from '../../shared/agent-status-types'
import type { RuntimeWorktreeAgentRow, RuntimeWorktreePsSummary } from '../../shared/runtime-types'
import { mergeWorktreeSummaryStatus } from './runtime-worktree-status-projection'
import type { RuntimeWorktreeSummaryPathIndex } from './runtime-worktree-summary-paths'
import type { RuntimeWorkingTerminalEvidence } from './runtime-worktree-ps-activity'
import type { RuntimeWorktreeAgentSource } from './runtime-worktree-agent-source'
export type { RuntimeAgentRowSnapshot } from './runtime-worktree-pty-agent-sources'

type OrchestrationDisplay = {
  taskTitle?: string | null
  displayName?: string | null
  parentPaneKey?: string | null
}

export function attachRuntimeWorktreeAgentRows(args: {
  summaries: Map<string, RuntimeWorktreePsSummary>
  pathIndex: RuntimeWorktreeSummaryPathIndex
  missingWorktreeIds: Set<string>
  rowSources: ReadonlyMap<string, RuntimeWorktreeAgentSource>
  workingTerminalEvidenceByWorktreeId: ReadonlyMap<
    string,
    readonly RuntimeWorkingTerminalEvidence[]
  >
  orchestrationByPaneKey: Record<string, OrchestrationDisplay> | null | undefined
  getSummary: (
    summaries: Map<string, RuntimeWorktreePsSummary>,
    pathIndex: RuntimeWorktreeSummaryPathIndex,
    missingWorktreeIds: Set<string>,
    worktreeId: string
  ) => RuntimeWorktreePsSummary | null
}): void {
  const { rowSources } = args
  const now = Date.now()
  const rowsByWorktree = new Map<string, RuntimeWorktreeAgentRow[]>()
  for (const source of rowSources.values()) {
    const { worktreeId } = source
    if (!worktreeId) {
      continue
    }
    const summary = args.getSummary(
      args.summaries,
      args.pathIndex,
      args.missingWorktreeIds,
      worktreeId
    )
    if (!summary) {
      continue
    }
    const orchestration = args.orchestrationByPaneKey?.[source.paneKey]
    const row: RuntimeWorktreeAgentRow = {
      paneKey: source.paneKey,
      parentPaneKey: orchestration?.parentPaneKey ?? null,
      state: source.state,
      ...(source.workingMode ? { workingMode: source.workingMode } : {}),
      agentType: source.agentType,
      prompt: source.prompt,
      taskTitle: orchestration?.taskTitle ?? null,
      displayName: orchestration?.displayName ?? null,
      lastAssistantMessage: source.lastAssistantMessage,
      toolName: source.toolName,
      toolInput: source.toolInput,
      interrupted: source.interrupted,
      stateStartedAt: source.stateStartedAt,
      updatedAt: source.updatedAt
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
      const source = rowSources.get(row.paneKey)
      const hostHeldStructuredSession =
        source?.authority === 'structured-host' && row.state !== 'done'
      if (!hostHeldStructuredSession && !isFreshNonDoneAgentStatus(row, now)) {
        continue
      }
      summary.hasHostSidebarActivity = true
      if (row.state === 'working') {
        if (row.workingMode === 'monitoring') {
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
        args.workingTerminalEvidenceByWorktreeId.get(worktreeId) ?? []
      ).some((evidence) =>
        monitoringSources.every((source) => !workingTerminalEvidenceMatchesSource(evidence, source))
      )
      mergeWorktreeSummaryStatus(
        summary,
        'working',
        hasForegroundWorkingAgent || hasIndependentWorkingTerminal ? undefined : 'monitoring'
      )
    }
  }
}

function workingTerminalEvidenceMatchesSource(
  evidence: RuntimeWorkingTerminalEvidence,
  source: RuntimeWorktreeAgentSource
): boolean {
  if (evidence.paneKey) {
    return (
      evidence.paneKey === source.paneKey ||
      Boolean(evidence.ptyId && source.ptyId && evidence.ptyId === source.ptyId)
    )
  }
  if (evidence.ptyId && source.ptyId) {
    return evidence.ptyId === source.ptyId
  }
  return Boolean(evidence.tabId && evidence.tabId === source.tabId)
}
