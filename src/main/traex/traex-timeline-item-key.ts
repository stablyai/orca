import { agentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { createLegacyProviderTimelineIdentityScheme } from '../native-chat/agent-session-timeline/provider-timeline-identity'
import type { StructuredAgentSessionTransitionJournal } from '../native-chat/agent-session-wire/journal-ingress/structured-agent-session-transition'

export function traexTimelineItemKey(turnId: string, itemId: string): string {
  return JSON.stringify([turnId, itemId])
}

export function createTraexTimelineItemKeyResolver(input: {
  sessionId: string
  threadId: string
  journal: () => Pick<StructuredAgentSessionTransitionJournal, 'item'> | null | undefined
}): (turnId: string, itemId: string) => string {
  const scheme = createLegacyProviderTimelineIdentityScheme({
    agent: 'trae',
    sessionId: input.sessionId
  })
  return (turnId, itemId) => {
    const old = input.journal()?.item(
      agentJournalItemKey(
        scheme.item({
          namespace: input.threadId,
          thread: input.threadId,
          family: 'item',
          key: { source: 'provider', value: itemId }
        })
      )
    )
    const root = agentJournalItemKey(
      scheme.turn({
        namespace: input.threadId,
        key: { source: 'provider', value: turnId }
      })
    )
    return old?.turnScope?.kind === 'turn' && old.turnScope.turnItemId === root
      ? itemId
      : traexTimelineItemKey(turnId, itemId)
  }
}
