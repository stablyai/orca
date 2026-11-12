import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-worktree-contracts'
import type { Worktree } from '../worktree/workspace-list-types'
import { agentDotState, agentRowTimeAt, type AgentDotState } from '../worktree/agent-row-display'

export type HostActivityGroup = 'waiting' | 'working' | 'monitoring' | 'done' | 'other'
export type HostActivityRow = {
  key: string
  worktree: Worktree
  agent: RuntimeWorktreeAgentRow
  title: string
  dotState: AgentDotState
}
export type HostActivitySection = { key: HostActivityGroup; data: HostActivityRow[] }

function activityGroup(state: AgentDotState): HostActivityGroup {
  if (state === 'waiting' || state === 'blocked' || state === 'failed' || state === 'interrupted') {
    return 'waiting'
  }
  return state === 'working' || state === 'monitoring' || state === 'done' ? state : 'other'
}

export function buildHostActivitySections(
  worktrees: readonly Worktree[],
  search: string,
  now: number
): HostActivitySection[] {
  const query = search.trim().toLocaleLowerCase()
  const groups: HostActivitySection[] = (
    ['waiting', 'working', 'monitoring', 'done', 'other'] as const
  ).map((key) => ({ key, data: [] }))
  const seen = new Set<string>()
  for (const worktree of worktrees) {
    for (const agent of worktree.agents ?? []) {
      const key = JSON.stringify([worktree.hostId ?? '', worktree.worktreeId, agent.paneKey])
      if (!agent.paneKey || seen.has(key)) {
        continue
      }
      seen.add(key)
      const title =
        agent.conversationName?.trim() ||
        agent.taskTitle?.trim() ||
        agent.displayName?.trim() ||
        agent.prompt?.trim() ||
        agent.agentType ||
        worktree.displayName
      if (
        query &&
        ![
          title,
          worktree.repo,
          worktree.displayName,
          worktree.branch,
          agent.lastAssistantMessage,
          agent.prompt
        ].some((value) => value?.toLocaleLowerCase().includes(query))
      ) {
        continue
      }
      const dotState = agentDotState(agent, now)
      groups
        .find((group) => group.key === activityGroup(dotState))!
        .data.push({
          key,
          worktree,
          agent,
          title,
          dotState
        })
    }
  }
  for (const group of groups) {
    group.data.sort(
      (a, b) => agentRowTimeAt(b.agent) - agentRowTimeAt(a.agent) || a.key.localeCompare(b.key)
    )
  }
  return groups.filter((group) => group.data.length > 0)
}
