import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import type { NativeChatSubagentEntry } from '../../shared/native-chat-types'
import {
  MAX_SUBAGENT_FIELD_CHARS,
  subagentGroupFallbackText
} from '../../shared/native-chat-subagent-summary'

/** The roster row: the structured block plus the plain sentence an older client
 *  renders in its place. A message whose only block is the new variant would
 *  reach such a client with nothing it can draw. */
export function codexSubagentGroupBody(
  groupId: string,
  agents: readonly NativeChatSubagentEntry[]
): AgentJournalItemBody {
  const bounded = agents.map((agent, index) => ({
    ...agent,
    id: boundSubagentField(agent.id, index),
    label: boundSubagentField(agent.label, index)
  }))
  return {
    kind: 'message',
    role: 'system',
    blocks: [
      { type: 'text', text: subagentGroupFallbackText(bounded) },
      { type: 'subagent-group', groupId, agents: bounded }
    ]
  }
}

/** `id` and `label` are provider strings, so they take the bound both readers of
 *  this row already clip them to. A plain length check, not the tool-output
 *  bound: that one digests the whole value before it checks the length, and this
 *  runs twice per child on every streamed token-usage frame.
 *
 *  A clip is not identity-preserving, so a clipped value carries the child's
 *  index: two ids sharing a long prefix collapse to one React key, and
 *  `claimLabel` writes its ordinal at the very tail the clip removes. The index
 *  is reserved out of the bound, not appended to it, because both readers
 *  re-clip to the same cap and would cut a suffix that overflowed it. */
export function boundSubagentField(value: string, index: number): string {
  if (value.length <= MAX_SUBAGENT_FIELD_CHARS) {
    return value
  }
  const suffix = `…~${index}`
  const keep = MAX_SUBAGENT_FIELD_CHARS - suffix.length
  // Slicing UTF-16 units can split a surrogate pair; a lone surrogate is
  // malformed in a durable row and lossy through any non-JSON UTF-8 hop.
  const last = value.charCodeAt(keep - 1)
  const end = last >= 0xd800 && last <= 0xdbff ? keep - 1 : keep
  return `${value.slice(0, end)}${suffix}`
}
