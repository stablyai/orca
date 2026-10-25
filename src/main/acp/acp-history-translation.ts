// A replayed turn written as the chat's lane writes a live one: the same translator and assembler,
// so its rows carry exactly the keys and bodies a live turn would have, into a staging overlay.

import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { AgentType } from '../../shared/agent-status-types'
import { createProviderTimelineAssembler } from '../native-chat/agent-session-timeline/provider-timeline-assembler'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { agentJournalTurnBody, readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import type { AcpDialect } from './acp-dialects/acp-dialect'
import { AcpHistoryJournalOverlay, type AcpHistoryItem } from './acp-history-journal-overlay'
import {
  acpHistoryFrameTime,
  type AcpHistoryTurnIdentity,
  type AcpIdentifiedHistoryTurn
} from './acp-history-replay'
import { AcpTimelineTranslator } from './acp-timeline-translator'

/** The chat a replay belongs to. */
export type AcpHistoryScope = {
  /** Orca's session id. */
  sessionId: string
  agent: AgentType
  providerSessionId: string
  dialect: AcpDialect
  /** How the agent names each turn it replays. */
  identity: AcpHistoryTurnIdentity
}

class AcpHistoryTranslator extends AcpTimelineTranslator {
  openHistoryTurn(turn: string, at: number): ProviderTimelineEvent[] {
    return this.start(turn, at)
  }
}

/** Each turn gets its own translator and assembler, so its rows are keyed the same on every open. */
export function translateHistoryTurn(
  scope: AcpHistoryScope,
  turn: AcpIdentifiedHistoryTurn,
  check: () => void = () => {}
): AcpHistoryItem[] {
  const overlay = new AcpHistoryJournalOverlay('history-snapshot')
  const translator = new AcpHistoryTranslator({
    sessionId: scope.providerSessionId,
    dialect: scope.dialect,
    onTextDropped: () => {
      throw new Error('history-text-dropped')
    }
  })
  const assembler = createProviderTimelineAssembler({
    sink: overlay.sink,
    sessionId: scope.sessionId,
    agent: scope.agent,
    generation: `history:${turn.turn}`,
    namespace: scope.providerSessionId,
    schedule: () => () => {}
  })
  const at = turn.startedAt ?? 0
  const apply = (events: readonly ProviderTimelineEvent[]) => {
    for (const event of events) {
      const result = assembler.apply(event)
      if (!result.admission.accepted || (result.dropped && result.dropped !== 'turn-duplicate')) {
        throw new Error('history-not-admitted')
      }
    }
  }
  try {
    apply(translator.openHistoryTurn(turn.turn, at))
    for (const observation of [turn.user, ...turn.observations]) {
      check()
      const frame = 'blocks' in observation ? observation.boundary : observation
      apply(translator.notification(frame.method, frame.params, acpHistoryFrameTime(frame) ?? at))
      if ('blocks' in observation) {
        apply([
          {
            type: 'item.update',
            item:
              observation === turn.user
                ? `user:${turn.turn}`
                : `user-message:${JSON.stringify([turn.turn, observation.eventId])}`,
            body: { kind: 'message', role: 'user', blocks: observation.blocks },
            join: { thread: scope.providerSessionId, turn: turn.turn }
          }
        ])
      }
    }
    assembler.flush()
    const created = overlay.created()
    const opener = created.find((item) => item.body.kind === 'message' && item.body.role === 'user')
    if (!opener) {
      throw new Error('no-history-opener')
    }
    return created.map((mutation) => {
      const lifecycle = readAgentJournalTurn(mutation.body)
      if (!lifecycle) {
        return mutation
      }
      const { startedAt, ...body } = lifecycle
      return {
        ...mutation,
        body: agentJournalTurnBody({
          ...body,
          userItemId: agentJournalItemKey(opener.identity),
          ...(turn.startedAt === null ? {} : { startedAt }),
          ...(lifecycle.state === 'running' ? { state: 'completed' as const } : {})
        })
      }
    })
  } finally {
    assembler.dispose()
    translator.dispose()
  }
}
