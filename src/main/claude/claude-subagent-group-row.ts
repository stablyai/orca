// The journal row one Claude spawn group writes: its durable identity and the
// body it revises in place.

import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { normalizeSubagentState } from '../../shared/native-chat-subagent-summary'
import type { NativeChatSubagentEntry } from '../../shared/native-chat-types'

/** Durable journal identity for the group's row — stable across revisions and
 *  across a restart, so replay finds the same row instead of appending a new one. */
export function claudeSubagentGroupIdentity(groupId: string): AgentJournalItemIdentity {
  return { provider: 'orca', clientMessageId: `claude-subagents:${groupId}` }
}

/** The roster row: the structured block plus the plain sentence an older client
 *  renders in its place. A message whose only block is the new variant would
 *  reach such a client with nothing it can draw. */
export function claudeSubagentGroupBody(
  groupId: string,
  agents: readonly NativeChatSubagentEntry[]
): AgentJournalItemBody {
  return {
    kind: 'message',
    role: 'system',
    blocks: [
      { type: 'text', text: subagentGroupFallbackText(agents) },
      { type: 'subagent-group', groupId, agents: [...agents] }
    ]
  }
}

/** Outcomes that must be visible immediately, not held back until the last
 *  sibling stops working: a fan-out with a dead child is not a neutral row. */
const ADVERSE_PRECEDENCE = ['failed', 'stopped', 'unverifiable'] as const

/** Plain-text stand-in for the roster, for clients without the block type. It
 *  carries the adverse count too: mobile and paired web have no roster renderer,
 *  so a reader that only ever sees this write-time sentence must not be told a
 *  fan-out that lost a child is fine. */
function subagentGroupFallbackText(agents: readonly NativeChatSubagentEntry[]): string {
  const counts = new Map<string, number>()
  let working = 0
  for (const agent of agents) {
    const state = normalizeSubagentState(agent.state)
    if (state === 'working') {
      working += 1
    } else {
      counts.set(state, (counts.get(state) ?? 0) + 1)
    }
  }
  const adverseState = ADVERSE_PRECEDENCE.find((state) => counts.has(state)) ?? null
  const noun = agents.length === 1 ? 'subagent' : 'subagents'
  const adverse = adverseState === null ? '' : ` (${counts.get(adverseState) ?? 0} ${adverseState})`
  return working > 0
    ? `Kicked off ${agents.length} ${noun} — ${working} working${adverse}`
    : `Ran ${agents.length} ${noun}${adverse}`
}
