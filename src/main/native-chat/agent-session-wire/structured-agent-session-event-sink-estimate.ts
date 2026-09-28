import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'

export function estimateStructuredAgentSessionItemBytes(
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody
): number {
  return Buffer.byteLength(JSON.stringify({ identity, body }), 'utf8') + 512
}
