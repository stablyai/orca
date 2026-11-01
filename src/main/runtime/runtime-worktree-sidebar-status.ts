import { isAgentStatusFresh } from '../../shared/agent-status-freshness'
import type { RuntimeWorktreePsSummary } from '../../shared/runtime-types'
import {
  applyAgentPaneActivityFlags,
  createAgentPaneActivityFlags,
  rankWorktreeStatus,
  type WorktreeStatus
} from '../../shared/worktree-status-rollup'
import type { RuntimeWorktreeAgentSource } from './runtime-worktree-agent-source'
import type { RuntimeTerminalTitleEvidence } from './runtime-worktree-ps-activity'

type AgentTitleSource = Pick<RuntimeWorktreeAgentSource, 'paneKey' | 'ptyId' | 'tabId'>

export function terminalTitleEvidenceMatchesSource(
  evidence: RuntimeTerminalTitleEvidence,
  source: AgentTitleSource
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

/** The desktop sidebar dot: host status stands in for the title heuristic under fresh agent verdicts. */
export function resolveRuntimeWorktreeSidebarStatus(
  summary: Pick<RuntimeWorktreePsSummary, 'status' | 'agents'>,
  now: number,
  titleEvidence: readonly RuntimeTerminalTitleEvidence[],
  sourceOf: (paneKey: string) => AgentTitleSource | undefined
): WorktreeStatus {
  if (summary.agents.length === 0 && titleEvidence.length === 0) {
    return summary.status === 'working' || summary.status === 'permission'
      ? 'active'
      : summary.status
  }
  const flags = createAgentPaneActivityFlags()
  const freshSources: AgentTitleSource[] = []
  // Why: like desktop, a finished worker also silences its orchestrating parent's title.
  const finishedWorkerParents = new Set<string>()
  for (const row of summary.agents) {
    if (!isAgentStatusFresh(row, now)) {
      continue
    }
    applyAgentPaneActivityFlags(flags, row)
    const source = sourceOf(row.paneKey)
    if (source) {
      freshSources.push(source)
    }
    if (row.state === 'done' && row.parentPaneKey) {
      finishedWorkerParents.add(row.parentPaneKey)
    }
  }
  // Why: desktop ignores titles of panes with a fresh agent row; live rows return through the flags.
  const titles = titleEvidence.filter(
    (evidence) =>
      !(evidence.paneKey && finishedWorkerParents.has(evidence.paneKey)) &&
      freshSources.every((source) => !terminalTitleEvidenceMatchesSource(evidence, source))
  )
  const titleStatus = titles.some((evidence) => evidence.status === 'permission')
    ? 'permission'
    : titles.length > 0
      ? 'working'
      : 'active'
  const heuristic =
    summary.status === 'working' || summary.status === 'permission' ? titleStatus : summary.status
  return rankWorktreeStatus(heuristic, flags)
}
