import { agentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  agentJournalTurnBody,
  readAgentJournalTurn
} from '../../shared/agent-session/lifecycle/agent-session-turn-record'
import { createProviderTimelineAssembler } from '../native-chat/agent-session-timeline/provider-timeline-assembler'
import {
  ProviderTimelineHistoryOverlay,
  type ProviderTimelineHistoryItem
} from '../native-chat/agent-session-timeline/provider-timeline-history-overlay'
import { traexItemEvents } from './traex-item-translation'
import type { TraexTurn } from './traex-protocol'
import type { AgentJournalProducerLinkage } from '../../shared/agent-session/journal/agent-session-journal-types'

export function projectTraexHistoryTurn(input: {
  threadId: string
  sessionId: string
  turn: TraexTurn
  epoch: string
  representedClientId?: string
  itemKey?: (turnId: string, itemId: string) => string
  primaryThreadId?: string
  producer?: AgentJournalProducerLinkage
}): ProviderTimelineHistoryItem[] {
  const { turn } = input
  const overlay = new ProviderTimelineHistoryOverlay(input.epoch)
  const assembler = createProviderTimelineAssembler({
    sink: overlay.sink,
    sessionId: input.sessionId,
    agent: 'trae',
    generation: `history:${turn.id}`,
    namespace: input.threadId,
    ownThread: () => input.primaryThreadId ?? input.threadId,
    schedule: () => () => {}
  })
  try {
    if (input.representedClientId) {
      assembler.apply({
        type: 'input.accepted',
        clientMessageId: input.representedClientId,
        requestedAt: (turn.startedAt ?? 0) * 1000,
        join: { thread: input.threadId, turn: turn.id }
      })
    }
    if (!input.producer) {
      assembler.apply({ type: 'turn.open', turn: turn.id, at: (turn.startedAt ?? 0) * 1000 })
    }
    for (const item of turn.items ?? []) {
      if (input.representedClientId && item.type === 'userMessage') {
        continue
      }
      for (const event of traexItemEvents(
        item,
        input.threadId,
        turn.id,
        true,
        input.itemKey?.(turn.id, item.type === 'contextCompaction' ? 'contextCompaction' : item.id)
      )) {
        assembler.apply(
          input.producer && (event.type === 'item.open' || event.type === 'item.close')
            ? { ...event, producer: input.producer }
            : event
        )
      }
    }
    if (!input.producer && ['completed', 'failed', 'interrupted'].includes(turn.status)) {
      assembler.apply({
        type: 'turn.end',
        turn: turn.id,
        at: (turn.completedAt ?? turn.startedAt ?? 0) * 1000,
        state: turn.status === 'interrupted' ? 'interrupted' : 'completed',
        outcome:
          turn.status === 'failed' ? 'failure' : turn.status === 'completed' ? 'success' : undefined
      })
    }
    const mutations = overlay.created()
    const opener = mutations.find(
      (mutation) => mutation.body.kind === 'message' && mutation.body.role === 'user'
    )
    return mutations.map((mutation) => {
      const lifecycle = readAgentJournalTurn(mutation.body)
      return lifecycle
        ? {
            ...mutation,
            body: agentJournalTurnBody({
              ...lifecycle,
              providerTurnId: turn.id,
              userItemId: opener ? agentJournalItemKey(opener.identity) : lifecycle.userItemId
            })
          }
        : mutation
    })
  } finally {
    assembler.dispose()
  }
}
