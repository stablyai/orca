import type { AgentSessionLease, AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionProviderHandleLink,
  StructuredAgentId
} from '../../../shared/agent-session-provider-handle'

export type StructuredProviderSessionOwnership = {
  sessionId: string
  workspaceId: string
  provider: StructuredAgentId
  providerSessionId: string
  conversationName?: string
  lease: AgentSessionLease
}

export function listStructuredProviderSessionOwnership(
  records: readonly AgentSessionRecord[],
  /** The id a link is owned under; a link it answers undefined for is owned under none. */
  providerSessionId: (
    record: AgentSessionRecord,
    link: AgentSessionProviderHandleLink
  ) => string | undefined
): StructuredProviderSessionOwnership[] {
  return records.flatMap((record) =>
    record.providerHandleChain.flatMap((link) => {
      const id = providerSessionId(record, link)
      return id === undefined
        ? []
        : [
            {
              sessionId: record.sessionId,
              workspaceId: record.location.workspaceId,
              provider: record.provider,
              providerSessionId: id,
              conversationName: record.conversationName,
              lease: record.lease
            }
          ]
    })
  )
}
