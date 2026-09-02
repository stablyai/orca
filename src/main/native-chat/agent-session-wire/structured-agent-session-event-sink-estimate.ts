import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionJournalBlob } from './structured-agent-session-event-sink'

export function estimateStructuredAgentSessionItemBytes(
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody,
  blobs: readonly StructuredAgentSessionJournalBlob[]
): number {
  return (
    Buffer.byteLength(JSON.stringify({ identity, body }), 'utf8') +
    blobs.reduce((total, blob) => total + Buffer.byteLength(blob.payload, 'utf8'), 0) +
    512
  )
}
