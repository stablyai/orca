// The journal row one Claude spawn group writes: its durable identity and the
// body it revises in place.

import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { subagentGroupFallbackText } from '../../shared/native-chat-subagent-summary'
import type { NativeChatSubagentEntry } from '../../shared/native-chat-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { RosterGroup } from './claude-subagent-roster-state'

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

/**
 * Revise one group's row to match its current children.
 *
 * Deliberately ROOT, and it is the one row in this lane where that needs saying:
 * it is written from a child's frame but describes the PARENT's children, so it
 * is the session's own agent reporting what it spawned. Stamping it as a child's
 * would hide the roster from the very row that owns it.
 */
export function writeClaudeSubagentGroupRow(
  sink: StructuredAgentSessionEventSink,
  group: RosterGroup
): void {
  const agents = [...group.entries.values()].map((tracked) => tracked.entry)
  const options = { coalescingKey: `claude-subagents:${group.groupId}`, turnScope: group.turnScope }
  if (agents.length === 0) {
    // The row's last child turned out not to be a subagent. An empty roster is
    // not a roster of nothing, so the row goes rather than reading "Ran 0".
    if (group.lastSerialized !== null) {
      group.lastSerialized = null
      sink.appendTombstone(group.identity, options)
      sink.publish()
    }
    return
  }
  const body = claudeSubagentGroupBody(group.groupId, agents)
  const serialized = JSON.stringify(body)
  if (serialized === group.lastSerialized) {
    // Nothing changed — a duplicate delivery must not burn a revision.
    return
  }
  group.lastSerialized = serialized
  sink.appendItem(group.identity, body, options)
  // Publish keeps the sink's own coalescing slot: sharing the row's key makes
  // each queued publish evict the append it was meant to flush.
  sink.publish()
}
