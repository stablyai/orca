import type { Worktree } from '../../worktree/workspace-list/workspace-list-types'
import { agentListPreview, agentListTitle } from '../../agents/agent-list-row-text'
import { agentStatusGroup } from '../../agents/agent-list-rows'
import {
  agentDotState,
  agentStateLabel,
  type AgentDotState
} from '../../worktree/agent-lineage/agent-row-display'
import type { Translate } from '../../i18n/mobile-i18n'
import { mobileAgentAskLine } from './mobile-session-tab-rows'

const SHOWN = 3

export type OtherWorkspaceRow = {
  worktreeId: string
  name: string
  /** Agents there waiting on you; the first one's ask is on the row and its tab is where a tap lands. */
  needsYou: number
  stateWord: string
  ask: string
  paneKey: string | null
  activityAt: number | null
}

/**
 * The sidebar's other workspaces on this computer: any with an agent waiting first, then the most
 * recently active. Agent state only exists after a live read of the host list (the saved copy drops
 * it), so with none the rows are simply the most recent.
 */
export function otherWorkspaceRows(
  worktrees: readonly Worktree[],
  currentWorktreeId: string,
  now: number,
  t: Translate
): OtherWorkspaceRow[] {
  type Candidate = {
    row: Worktree
    needsYou: number
    waiting: { agent: NonNullable<Worktree['agents']>[number]; state: AgentDotState } | null
    activityAt: number | null
  }
  const ahead = (a: Candidate, b: Candidate) =>
    a.needsYou > 0 !== b.needsYou > 0 ? a.needsYou > 0 : (a.activityAt ?? 0) > (b.activityAt ?? 0)
  // One pass that keeps only the best three, so a host with hundreds of workspaces sorts nothing.
  const best: Candidate[] = []
  for (const row of worktrees) {
    // A paired server's workspaces open through its relay, which the host list checks first.
    if (
      row.worktreeId === currentWorktreeId ||
      row.isArchived ||
      row.hostId?.startsWith('runtime:')
    ) {
      continue
    }
    let needsYou = 0
    let waiting: Candidate['waiting'] = null
    for (const agent of row.agents ?? []) {
      const state = agentDotState(agent, now)
      if (agentStatusGroup(state) !== 'needs-you') {
        continue
      }
      needsYou += 1
      if (!waiting || agent.stateStartedAt > waiting.agent.stateStartedAt) {
        waiting = { agent, state }
      }
    }
    const candidate = {
      row,
      needsYou,
      waiting,
      activityAt: row.lastActivityAt ?? row.lastOutputAt ?? null
    }
    const at = best.findIndex((other) => ahead(candidate, other))
    if (at !== -1 || best.length < SHOWN) {
      best.splice(at === -1 ? best.length : at, 0, candidate)
      best.length = Math.min(best.length, SHOWN)
    }
  }
  // Only the rows shown read what their agent asks.
  return best.map(({ row, needsYou, waiting, activityAt }) => {
    // Worded as the tab rows word it ("Allow Edit?"), else the Agents list's state and preview.
    const ask = waiting ? mobileAgentAskLine(waiting.agent, waiting.state, t) : null
    return {
      worktreeId: row.worktreeId,
      name: row.displayName || row.repo,
      needsYou,
      stateWord: ask?.stateWord ?? (waiting ? agentStateLabel(waiting.state, t) : ''),
      ask:
        ask?.content ??
        (waiting
          ? agentListPreview(waiting.agent, 'needs-you', agentListTitle(waiting.agent))
          : ''),
      paneKey: waiting?.agent.paneKey ?? null,
      activityAt
    }
  })
}
