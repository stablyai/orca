// The journal row one Claude spawn group writes: its durable identity and the
// body it revises in place.

import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { subagentGroupFallbackText } from '../../shared/native-chat-subagent-summary'
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
