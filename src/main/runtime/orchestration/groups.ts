import type { RuntimeTerminalSummary } from '../../../shared/runtime-types'
import type { BuiltInTuiAgent } from '../../../shared/types'

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

// Base-to-group map (oracle 16): agent-name groups resolve from a terminal's
// validated base harness, never its title text. Only bases with an addressable
// group appear; the `mimo-code` base maps to the existing `@mimo` group name.
const BASE_AGENT_TO_GROUP: Partial<Record<BuiltInTuiAgent, AgentNameGroup>> = {
  claude: 'claude',
  openclaude: 'openclaude',
  codex: 'codex',
  opencode: 'opencode',
  'mimo-code': 'mimo',
  gemini: 'gemini',
  droid: 'droid',
  grok: 'grok',
  cursor: 'cursor'
}

export type GroupAddress = '@all' | '@idle' | `@${AgentNameGroup}` | `@worktree:${string}`

export function isGroupAddress(to: string): boolean {
  return to.startsWith('@')
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

  // Why: agent-name groups (@claude, @droid, etc.) match by the terminal's
  // validated base harness, not title text — a custom agent joins its base's
  // group, and an unattributed terminal is omitted rather than guessed.
  const agentName = group.slice(1) // remove @
  if ((AGENT_NAME_GROUPS as readonly string[]).includes(agentName)) {
    return terminals
      .filter((t) => {
        if (t.handle === senderHandle) {
          return false
        }
        return t.baseAgent !== undefined && BASE_AGENT_TO_GROUP[t.baseAgent] === agentName
      })
      .map((t) => t.handle)
  }

  // Why: unknown groups resolve to empty rather than throwing so callers can
  // distinguish "valid group, no current members" from programming errors.
  return []
}
