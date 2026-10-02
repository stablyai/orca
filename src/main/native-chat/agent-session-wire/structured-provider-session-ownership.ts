import type { AgentSessionLease, AgentSessionRecord } from '../../../shared/agent-session-record'

export type StructuredProviderSessionOwnership = {
  sessionId: string
  workspaceId: string
  provider: 'claude' | 'codex'
  providerSessionId: string
  lease: AgentSessionLease
}

export function listStructuredProviderSessionOwnership(
  records: readonly AgentSessionRecord[]
): StructuredProviderSessionOwnership[] {
  return records.flatMap((record) =>
    record.providerHandleChain.flatMap((link) =>
      link.handle.provider === 'acp'
        ? []
        : [
            {
              sessionId: record.sessionId,
              workspaceId: record.location.workspaceId,
              provider: link.handle.provider,
              providerSessionId:
                link.handle.provider === 'codex' ? link.handle.threadId : link.handle.sessionId,
              lease: record.lease
            }
          ]
    )
  )
}
