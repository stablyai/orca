import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { claudeSourceBlockId } from '../structured/journal/claude-streamed-block-identity'
import {
  claudeMessageIdentity,
  claudeRecord,
  claudeThinkingIdentity,
  claudeToolIdentity,
  claudeToolResults,
  claudeToolUses,
  type readClaudeMessageEnvelope
} from '../structured/journal/claude-structured-item-translation'

/** Each group is the identity candidates of one saved item a transcript row may revise, in match order. */
export function claudeTranscriptSourceIdentities(
  row: Record<string, unknown>,
  envelope: NonNullable<ReturnType<typeof readClaudeMessageEnvelope>>
): AgentJournalItemIdentity[][] {
  const groups: AgentJournalItemIdentity[][] = []
  if (envelope.role === 'assistant') {
    const source =
      envelope.messageId && typeof row.apiBlockIndex === 'number'
        ? {
            provider: 'claude' as const,
            sessionId: envelope.sessionId,
            uuid: claudeSourceBlockId(envelope.messageId, row.apiBlockIndex)
          }
        : null
    const thinking = envelope.content.some((part) => claudeRecord(part)?.type === 'thinking')
    const frameIdentity = thinking
      ? claudeThinkingIdentity(envelope.sessionId, envelope.uuid)
      : claudeMessageIdentity(envelope)
    groups.push(source ? [source, frameIdentity] : [frameIdentity])
  }
  for (const tool of claudeToolUses(envelope)) {
    groups.push([claudeToolIdentity(envelope.sessionId, tool.id)])
  }
  for (const result of claudeToolResults(envelope)) {
    groups.push([claudeToolIdentity(envelope.sessionId, result.toolUseId)])
  }
  return groups
}
