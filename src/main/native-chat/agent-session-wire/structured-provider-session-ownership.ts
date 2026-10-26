import type { AgentSessionLease, AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentId } from '../../../shared/agent-session-provider-handle'
import { agentSessionLeaseOwnerVerdict } from '../../../shared/agent-session-lease-adjudication'
import { structuredAgentRuntimeMetadata } from '../../runtime/structured-agent-runtime-metadata'
import {
  keysMayMatch,
  recordConversationKey,
  type ConversationKey
} from '../structured-conversation-key'

export type StructuredProviderSessionOwnership = {
  sessionId: string
  workspaceId: string
  provider: StructuredAgentId
  providerSessionId: string
  conversationName?: string
  lease: AgentSessionLease
  /** `head`: the conversation the chat continues now; `earlier`: one its chain held before. */
  role: 'head' | 'earlier'
  key: ConversationKey
}

/** Use registration-defined History row IDs for both ownership display and duplicate-adoption checks. */
export function listStructuredProviderSessionOwnership(
  records: readonly AgentSessionRecord[]
): StructuredProviderSessionOwnership[] {
  return records.flatMap((record) => {
    const history = structuredAgentRuntimeMetadata(record.provider)?.sessionHistory
    const head = record.providerHandleChain.at(-1)
    const headKey = head ? recordConversationKey(record, head) : null
    return history && headKey
      ? record.providerHandleChain.flatMap((link) => {
          const key = recordConversationKey(record, link)
          return key
            ? [
                {
                  sessionId: record.sessionId,
                  workspaceId: record.location.workspaceId,
                  provider: record.provider,
                  providerSessionId: history.rowSessionId(link),
                  conversationName: record.conversationName,
                  lease: record.lease,
                  // A repeat resume link of the head's id is the head too.
                  role: keysMayMatch(key, headKey) ? ('head' as const) : ('earlier' as const),
                  key
                }
              ]
            : []
        })
      : []
  })
}

/** Fail closed: only a lease released on proof its owner exited can't be writing. */
export function agentSessionLeasePossiblyWriting(lease: AgentSessionLease): boolean {
  return agentSessionLeaseOwnerVerdict(lease) !== 'exited'
}

/** Agents whose chats let a terminal resume the same conversation once the chat stopped writing. */
export function sameIdTerminalResumeEnabled(_provider: StructuredAgentId): boolean {
  return false
}

/** Whether a terminal resume of this link's conversation is refused. */
export function terminalResumeBlocked(holding: StructuredProviderSessionOwnership): boolean {
  return (
    !sameIdTerminalResumeEnabled(holding.provider) ||
    (holding.role === 'head' && agentSessionLeasePossiblyWriting(holding.lease))
  )
}
