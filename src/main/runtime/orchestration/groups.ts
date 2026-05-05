import type { RuntimeTerminalSummary } from '../../../shared/runtime-types'

// Why: group addresses enable broadcast messaging to logical groups of agents.
// Resolution is done at send-time: one message record per recipient, same thread_id,
// so each recipient gets their own read-tracking (Section 4.5).

const AGENT_NAME_GROUPS = ['claude', 'codex', 'opencode', 'gemini'] as const

export type GroupAddress =
  | '@all'
  | '@idle'
  | `@${(typeof AGENT_NAME_GROUPS)[number]}`
  | `@worktree:${string}`

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

  // Why: agent-name groups (@claude, @codex, etc.) match by terminal title so
  // the sender can address all instances of a particular agent type without
  // knowing their handles.
  const agentName = group.slice(1) // remove @
  if ((AGENT_NAME_GROUPS as readonly string[]).includes(agentName)) {
    return terminals
      .filter((t) => {
        if (t.handle === senderHandle) {
          return false
        }
        const title = (t.title ?? '').toLowerCase()
        return title.includes(agentName)
      })
      .map((t) => t.handle)
  }

  // Why: unknown groups resolve to empty rather than throwing so callers can
  // distinguish "valid group, no current members" from programming errors.
  return []
}
