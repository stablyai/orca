import type {
  AgentSessionOwnerObservation,
  AgentSessionConversationView
} from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import type { StructuredAgentId } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import { retainedProviderHandles } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-retained-handles'
import { agentSessionOwnerObservationVerdict } from '../../../../shared/agent-session/lifecycle/leases/agent-session-lease-adjudication'
import {
  keysMayMatch,
  recordConversationKey,
  type ConversationKey
} from '../../conversation-adoption/structured-conversation-key'

export type StructuredProviderSessionOwnership = {
  wslDistro: string | null
  sessionId: string
  workspaceId: string
  provider: StructuredAgentId
  providerSessionId: string
  conversationName?: string
  ownerObservation: AgentSessionOwnerObservation
  /** `head`: the conversation the chat continues now; `earlier`: one its chain held before. */
  role: 'head' | 'earlier'
  retainedForSwitch?: true
  key: ConversationKey
}

/** Use registration-defined History row IDs for both ownership display and duplicate-adoption checks. */
export function listStructuredProviderSessionOwnership(
  records: readonly AgentSessionConversationView[]
): StructuredProviderSessionOwnership[] {
  return records.flatMap((record) => {
    const head = record.providerHandleChain.at(-1)
    const headKey =
      head?.handle.agent === record.provider ? recordConversationKey(record, head) : null
    const held = new Set(retainedProviderHandles(record))
    return record.providerHandleChain.flatMap((link): StructuredProviderSessionOwnership[] => {
      const key = recordConversationKey(record, link)
      if (!key?.id) {
        return []
      }
      const role = headKey && keysMayMatch(key, headKey) ? 'head' : 'earlier'
      return [
        {
          sessionId: record.sessionId,
          wslDistro: record.location.wslDistro,
          workspaceId: record.location.workspaceId,
          provider: link.handle.agent,
          providerSessionId: key.id,
          conversationName: record.conversationName,
          ownerObservation: record.ownerObservation,
          role,
          ...(role === 'earlier' && held.has(link) ? { retainedForSwitch: true } : {}),
          key
        }
      ]
    })
  })
}

/** Fail closed: only a lease released on proof its owner exited can't be writing. */
export function agentSessionLeasePossiblyWriting(lease: AgentSessionOwnerObservation): boolean {
  return agentSessionOwnerObservationVerdict(lease) !== 'exited'
}

/** Agents whose chats let a terminal resume the same conversation once the chat stopped writing. */
export function sameIdTerminalResumeEnabled(_provider: StructuredAgentId): boolean {
  return false
}

/** Whether a terminal resume of this link's conversation is refused. */
export function terminalResumeBlocked(holding: StructuredProviderSessionOwnership): boolean {
  return (
    !sameIdTerminalResumeEnabled(holding.provider) ||
    (holding.role === 'head' && agentSessionLeasePossiblyWriting(holding.ownerObservation))
  )
}
