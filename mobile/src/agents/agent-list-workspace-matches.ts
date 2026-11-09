import type { HomeWorkspaceEntry } from '../worktree/home-worktree-info'
import { fieldsMatchQueryWords } from './agent-list-row-text'
import type { AgentListInput } from './agent-list-rows'

// A search like "a" on a large desktop would otherwise list every workspace.
const WORKSPACE_MATCHES_SHOWN = 30

export type AgentListWorkspaceMatch = Readonly<{
  key: string
  hostId: string
  workspace: HomeWorkspaceEntry
}>

/**
 * Workspaces with no listed agent that match the search, from connected desktops only: the agent
 * rows already cover workspaces that have one, and an offline desktop can't open a workspace.
 */
export function matchAgentlessWorkspaces(
  input: AgentListInput,
  options: Readonly<{ hostFilter: string | null; query: string }>
): AgentListWorkspaceMatch[] {
  const query = options.query.trim().toLowerCase()
  if (!query) {
    return []
  }
  const matches: AgentListWorkspaceMatch[] = []
  for (const host of input.hosts) {
    const info = input.worktreeInfo[host.id]
    if (
      (options.hostFilter !== null && host.id !== options.hostFilter) ||
      input.hostStates[host.id] !== 'connected' ||
      !info?.workspaces ||
      info.catalogUnavailable
    ) {
      continue
    }
    // A workspace whose agents were all cleared from the list has none left to show it.
    const withAgents = new Set(
      (info.agents ?? [])
        .filter((entry) => entry.agent.activity?.listed !== false)
        .map((entry) => entry.worktreeId)
    )
    for (const workspace of info.workspaces) {
      if (
        !withAgents.has(workspace.worktreeId) &&
        fieldsMatchQueryWords([workspace.workspaceName, workspace.repo, workspace.branch], query)
      ) {
        matches.push({ key: `${host.id}:${workspace.worktreeId}`, hostId: host.id, workspace })
      }
    }
  }
  return matches.slice(0, WORKSPACE_MATCHES_SHOWN)
}
