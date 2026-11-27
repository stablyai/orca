// Agent-wide reasons Orca's servers don't reach an agent's sessions, as this host's launches last
// learned them, for the settings page's agent rows.
import type { McpAgentProblem, McpHostList } from '../../shared/mcp-servers/mcp-servers'

const CLAUDE_BLOCKED: McpAgentProblem = {
  kind: 'blocked',
  detail: 'Blocked by your organization’s Claude settings'
}

let claudeBlocked = false
/** By agent: why its terminals can't take the servers, as its latest terminal launch learned it. */
const terminalOff = new Map<string, string>()

/**
 * What a Claude launch or check learned: whether the organization's managed settings refuse
 * `--mcp-config` (a cached refusal, or a CLI that just exited with one). The latest one stands.
 */
export function noteClaudeMcpConfigRefused(refused: boolean): void {
  claudeBlocked = refused
}

/**
 * What an agent's terminal launch learned: null when its CLI took the servers, a reason when its
 * CLI can't take them at all (too old for the route), undefined when only this launch couldn't.
 */
export function noteTerminalMcpDelivery(agent: string, reason: string | null | undefined): void {
  if (reason === null) {
    terminalOff.delete(agent)
  } else if (reason !== undefined) {
    terminalOff.set(agent, reason)
  }
}

/** mcpServers.list's answer with the agents whose sessions get none of the list. */
export function withMcpAgentProblems(list: Omit<McpHostList, 'agentProblems'>): McpHostList {
  const problems: Record<string, McpAgentProblem> = Object.fromEntries(
    [...terminalOff].map(([agent, detail]) => [agent, { kind: 'terminal-off', detail }])
  )
  if (claudeBlocked) {
    problems.claude = CLAUDE_BLOCKED
  }
  return Object.keys(problems).length > 0 ? { ...list, agentProblems: problems } : list
}

/** Whether a launch learned that `agent`'s sessions on this host get none of the list. */
export function hasMcpAgentProblem(agent: string): boolean {
  return terminalOff.has(agent) || isMcpAgentBlocked(agent)
}

/** Whether `agent`'s chats get none of the list whatever it says: its settings refuse them. */
export function isMcpAgentBlocked(agent: string): boolean {
  return agent === 'claude' && claudeBlocked
}
