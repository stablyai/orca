import { agentJournalLinkageFields } from '../../../shared/agent-session-journal-producer'
import type { StructuredAgentSessionItemAppendOptions } from './structured-agent-session-event-sink'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'

export function estimateStructuredAgentSessionItemBytes(
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody,
  options: Partial<StructuredAgentSessionItemAppendOptions> = {}
): number {
  return (
    Buffer.byteLength(
      JSON.stringify({
        itemId: agentJournalItemKey(identity),
        body,
        ...agentJournalLinkageFields(options),
        turnScope: options.turnScope,
        observedAt: options.observedAt,
        echoOf: options.echoOf,
        executes: options.executes
      }),
      'utf8'
    ) + 512
  )
}
