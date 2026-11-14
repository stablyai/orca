import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalTurnScope } from '../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import type { ProviderTimelineIdentityScheme } from '../../native-chat/agent-session-timeline/provider-timeline-identity'
import type { StructuredAgentSessionTransitionJournal } from '../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-transition'
import { acpNamedTextKey } from '../timeline/acp-turn-messages'

export type AcpMessageOwner = {
  turn?: string
  scope?: AgentJournalTurnScope
  settled?: boolean
}

export type AcpOwnershipReader = {
  tool(callId: string): AgentJournalTurnScope | undefined
  message(messageId: string): AcpMessageOwner | undefined
  settled(turn: string): boolean
}

export function createAcpOwnershipReader(
  scheme: ProviderTimelineIdentityScheme,
  namespace: string,
  journal: () => StructuredAgentSessionTransitionJournal | null
): AcpOwnershipReader {
  const item = (key: string) =>
    journal()?.item(
      agentJournalItemKey(
        scheme.item({
          namespace,
          family: 'item',
          thread: namespace,
          key: { source: 'provider', value: key }
        })
      )
    )
  const settledScope = (scope: AgentJournalTurnScope) => {
    const state =
      scope.kind === 'turn'
        ? readAgentJournalTurn(journal()?.itemBody(scope.turnItemId) ?? undefined)?.state
        : undefined
    return state !== undefined && state !== 'running'
  }
  return {
    tool: (callId) => item(`tool:${callId}`)?.turnScope,
    message: (messageId) => {
      for (const channel of ['assistant', 'reasoning'] as const) {
        const scope = item(acpNamedTextKey(messageId, channel))?.turnScope
        if (scope) {
          return { scope, settled: settledScope(scope) }
        }
      }
      return undefined
    },
    settled: (turn) => {
      const body = journal()?.itemBody(
        agentJournalItemKey(scheme.turn({ namespace, key: { source: 'provider', value: turn } }))
      )
      const state = readAgentJournalTurn(body ?? undefined)?.state
      return state !== undefined && state !== 'running'
    }
  }
}
