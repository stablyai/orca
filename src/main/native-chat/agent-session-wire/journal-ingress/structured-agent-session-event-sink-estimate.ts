import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { jsonUtf8ByteLength } from '../../../../shared/json-stream/node-json-utf8-byte-length'

export function estimateStructuredAgentSessionItemBytes(
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody
): number {
  return jsonUtf8ByteLength({ identity, body }) + 512
}
