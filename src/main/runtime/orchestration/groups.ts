import type { TuiAgent } from '../../../shared/tui-agent'
import { ALL_TUI_AGENTS } from '../../../shared/tui-agent-display-names'
import type { OrchestrationAddressableAgent } from './structured-worker-group-addressing'

// Why: group addresses enable broadcast messaging to logical groups of agents.
// Resolution is done at send-time: one message record per recipient, same thread_id,
// so each recipient gets their own read-tracking (Section 4.5). The caller picks the
// candidates: the sender's Run for every group but `@worktree:<id>`, which names one
// workspace explicitly. There is no host-wide candidate set.

/** Group names that predate the canonical agent id and must keep resolving. */
const LEGACY_GROUP_NAME_ALIASES: Readonly<Record<string, TuiAgent>> = { mimo: 'mimo-code' }

/**
 * Group name to the agent id the host publishes for a pane.
 *
 * Why derived and not hand-kept: the literal this replaced named nine agents and drifted
 * behind the canonical list, leaving twenty-eight launchable agents — antigravity among
 * them — resolving to nobody, indistinguishable from a typo. `ALL_TUI_AGENTS` comes from a
 * record the compiler makes exhaustive over `TuiAgent`, so a new agent is addressable the
 * day it is declared.
 */
const GROUP_AGENT_IDS: ReadonlyMap<string, TuiAgent> = new Map<string, TuiAgent>([
  ...ALL_TUI_AGENTS.map((agent): [string, TuiAgent] => [agent, agent]),
  ...Object.entries(LEGACY_GROUP_NAME_ALIASES)
])

const WORKTREE_GROUP_PREFIX = '@worktree:'

/** Every agent-name group an address may use, canonical ids and legacy aliases alike. */
export const AGENT_GROUP_NAMES: readonly string[] = [...GROUP_AGENT_IDS.keys()]

export function isGroupAddress(to: string): boolean {
  return to.startsWith('@')
}

/**
 * Whether this address names a group Orca knows, members or not.
 *
 * Why separate from resolution: a misspelled group and a live group with no current members
 * both resolve to zero handles, so the sender was told the same thing either way. Callers ask
 * this first to report a typo as a typo.
 */
export function isRecognisedGroupAddress(to: string): boolean {
  if (!isGroupAddress(to)) {
    return false
  }
  const group = to.toLowerCase()
  return (
    group === '@all' ||
    group === '@idle' ||
    group.startsWith(WORKTREE_GROUP_PREFIX) ||
    GROUP_AGENT_IDS.has(group.slice(1))
  )
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
function terminalIsAgent(terminal: OrchestrationAddressableAgent, agentId: TuiAgent): boolean {
  return terminal.agentIdentity === agentId
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
    // Why: every candidate except the sender, to avoid self-delivery loops.
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
  if (group.startsWith(WORKTREE_GROUP_PREFIX)) {
    const worktreeId = to.slice(WORKTREE_GROUP_PREFIX.length)
    return terminals
      .filter((t) => t.handle !== senderHandle && t.worktreeId === worktreeId)
      .map((t) => t.handle)
  }

  // Why: agent-name groups (@claude, @droid, etc.) resolve against the identity the HOST
  // published for each pane, so the sender can address every instance of an agent without
  // knowing their handles — and without a task title being able to redirect the message.
  const agentId = GROUP_AGENT_IDS.get(group.slice(1)) // remove @
  if (agentId) {
    return terminals
      .filter((t) => {
        if (t.handle === senderHandle) {
          return false
        }
        return terminalIsAgent(t, agentId)
      })
      .map((t) => t.handle)
  }

  // Why still empty and not a throw: resolution stays total. Callers that must tell an
  // unknown group from an empty one ask `isRecognisedGroupAddress` first.
  return []
}
