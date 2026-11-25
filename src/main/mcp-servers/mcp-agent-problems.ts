// Agent-wide reasons Orca's servers don't reach an agent's sessions, as this host's launches last
// learned them, for the settings page's agent rows.
import type { McpAgentProblem, McpHostList } from '../../shared/mcp-servers/mcp-servers'

const CLAUDE_BLOCKED: McpAgentProblem = {
  kind: 'blocked',
  detail: 'Blocked by your organization’s Claude settings'
}

let claudeBlocked = false

/**
 * What a Claude launch or check learned: whether the organization's managed settings refuse
 * `--mcp-config` (a cached refusal, or a CLI that just exited with one). The latest one stands.
 */
export function noteClaudeMcpConfigRefused(refused: boolean): void {
  claudeBlocked = refused
}

/** mcpServers.list's answer with the agents whose sessions get none of the list. */
export function withMcpAgentProblems(list: Omit<McpHostList, 'agentProblems'>): McpHostList {
  return claudeBlocked ? { ...list, agentProblems: { claude: CLAUDE_BLOCKED } } : list
}
