import type { RuntimeTerminalSummary } from '../../../shared/runtime-types'
import type { TuiAgent } from '../../../shared/tui-agent'

// Why: group addresses enable broadcast messaging to logical groups of agents.
// Resolution is done at send-time: one message record per recipient, same thread_id,
// so each recipient gets their own read-tracking (Section 4.5).

const AGENT_NAME_GROUPS = [
  'claude',
  'openclaude',
  'codex',
  'opencode',
  'mimo',
  'gemini',
  'droid',
  'grok',
  'cursor'
] as const

type AgentNameGroup = (typeof AGENT_NAME_GROUPS)[number]

export function isGroupAddress(to: string): boolean {
  return to.startsWith('@')
}

/** Group name to the agent id the host publishes for a pane. */
const GROUP_AGENT_IDS: Record<AgentNameGroup, TuiAgent> = {
  claude: 'claude',
  openclaude: 'openclaude',
  codex: 'codex',
  opencode: 'opencode',
  mimo: 'mimo-code',
  gemini: 'gemini',
  droid: 'droid',
  grok: 'grok',
  cursor: 'cursor'
}

/**
 * Whether this terminal IS the addressed agent.
 *
 * Why the host's resolved identity and not the title: a terminal title is a decoration channel
 * that routinely contains other agents' names, because people describe agent work in their task
 * titles. Matching `@claude` against the title delivered the message to any pane whose task text
 * happened to say "claude" — a Codex pane reviewing a Claude PR received Claude's instructions.
 * Recorded titles like "Switch Claude and Codex off the load balancer… - grok" are the ordinary
 * case, not a contrived one.
 *
 * Why an absent identity means NO: `agentIdentity` is absent when the host predates the field or
 * had no evidence beyond the title. Delivery is an action, so unknown fails closed. Not
 * delivering is visible and recoverable — the sender sees no recipients; delivering to the wrong
 * agent is neither.
 */
function terminalIsAgent(terminal: RuntimeTerminalSummary, agentName: AgentNameGroup): boolean {
  return terminal.agentIdentity === GROUP_AGENT_IDS[agentName]
}

export function resolveGroupAddress(
  to: string,
  senderHandle: string,
  terminals: RuntimeTerminalSummary[],
  getAgentStatus: (handle: string) => string | null
): string[] {
  if (!isGroupAddress(to)) {
    return [to]
  }

  const group = to.toLowerCase()

  if (group === '@all') {
    // Why: @all broadcasts to every terminal except the sender to avoid self-delivery loops.
    return terminals.map((t) => t.handle).filter((h) => h !== senderHandle)
  }

  if (group === '@idle') {
    // Why: @idle targets only agents whose TUI reports idle status, useful for
    // dispatching work to available agents without interrupting busy ones.
    return terminals
      .filter((t) => t.handle !== senderHandle && getAgentStatus(t.handle) === 'idle')
      .map((t) => t.handle)
  }

  // @worktree:<id> — all handles in a specific worktree
  if (group.startsWith('@worktree:')) {
    const worktreeId = to.slice('@worktree:'.length)
    return terminals
      .filter((t) => t.handle !== senderHandle && t.worktreeId === worktreeId)
      .map((t) => t.handle)
  }

  // Why: agent-name groups (@claude, @droid, etc.) resolve against the identity the HOST
  // published for each pane, so the sender can address every instance of an agent without
  // knowing their handles — and without a task title being able to redirect the message.
  const agentName = group.slice(1) // remove @
  if ((AGENT_NAME_GROUPS as readonly string[]).includes(agentName)) {
    return terminals
      .filter((t) => {
        if (t.handle === senderHandle) {
          return false
        }
        return terminalIsAgent(t, agentName as AgentNameGroup)
      })
      .map((t) => t.handle)
  }

  // Why: unknown groups resolve to empty rather than throwing so callers can
  // distinguish "valid group, no current members" from programming errors.
  return []
}
