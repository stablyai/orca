import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session-journal-identity'

export function estimateStructuredAgentSessionItemBytes(
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody
): number {
  return Buffer.byteLength(JSON.stringify({ identity, body }), 'utf8') + 512
}
