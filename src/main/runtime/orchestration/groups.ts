import type { TuiAgent } from '../../../shared/tui-agent'
import type { OrchestrationAddressableAgent } from './structured-worker-group-addressing'

// Resolve per-recipient mail at send-time; candidates are Run-scoped except explicit @worktree addresses, never host-wide.

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

/** Route only by host-proven agent identity; titles may mention other agents, and unknown identity must fail closed. */
function terminalIsAgent(
  terminal: OrchestrationAddressableAgent,
  agentName: AgentNameGroup
): boolean {
  return terminal.agentIdentity === GROUP_AGENT_IDS[agentName]
}

export function resolveGroupAddress(
  to: string,
  senderHandle: string,
  terminals: readonly OrchestrationAddressableAgent[],
  getAgentStatus: (handle: string) => string | null
): string[] {
  if (!isGroupAddress(to)) {
    return [to]
  }

  const group = to.toLowerCase()

  if (group === '@all') {
    return terminals.map((t) => t.handle).filter((h) => h !== senderHandle)
  }

  if (group === '@idle') {
    return terminals
      .filter((t) => t.handle !== senderHandle && getAgentStatus(t.handle) === 'idle')
      .map((t) => t.handle)
  }

  if (group.startsWith('@worktree:')) {
    const worktreeId = to.slice('@worktree:'.length)
    return terminals
      .filter((t) => t.handle !== senderHandle && t.worktreeId === worktreeId)
      .map((t) => t.handle)
  }

  // Agent groups use host-resolved identity so titles cannot redirect mail.
  const agentName = group.slice(1)
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

  // Unknown groups produce no recipients rather than throwing.
  return []
}
