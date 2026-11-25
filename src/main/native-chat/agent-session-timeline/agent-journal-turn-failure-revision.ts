// Revise a turn's failure row and ending outcome against what has landed at the write position.

import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import {
  readAgentSessionFailureFact,
  providerDiagnostic
} from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import type { JournalTimelineView } from '../agent-session-journal/writing/journal-timeline-view'
import {
  agentJournalTurnRowReservedBytes,
  resolveAgentJournalTurnRowWrite,
  type AgentJournalTurnRowWrite
} from './agent-journal-turn-row-revision'

export type AgentJournalFailureVoice = {
  agentName: string
  provider: Parameters<typeof agentSessionFailureWords>[1]['provider']
}

/** Usage-limit facts accumulate their details; any other failure replaces the row. */
export function mergeAgentJournalTurnFailure(
  view: Pick<JournalTimelineView, 'itemBody'>,
  failure: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody },
  voice: AgentJournalFailureVoice
): { identity: AgentJournalItemIdentity; body: AgentJournalItemBody } | null {
  const { identity, body } = failure
  const old = view.itemBody(agentJournalItemKey(identity))
  const prior = old?.kind === 'status' ? readAgentSessionFailureFact(old.failure) : undefined
  const next = body.kind === 'status' ? readAgentSessionFailureFact(body.failure) : undefined
  const previousDetail = prior?.detail?.text
  const incomingDetail = next?.detail?.text
  const detail =
    previousDetail && incomingDetail && !previousDetail.includes(incomingDetail)
      ? `${previousDetail}\n${incomingDetail}`
      : (previousDetail ?? incomingDetail ?? '')
  const merged =
    prior?.kind === 'usageLimitReached' && next?.kind === 'usageLimitReached'
      ? {
          ...body,
          ...agentSessionFailureWords(
            {
              ...prior,
              ...next,
              usageLimit: next.usageLimit ?? prior.usageLimit,
              detail: providerDiagnostic(detail, 'person')
            },
            { ...voice, surface: 'row' }
          )
        }
      : body
  return JSON.stringify(merged) === JSON.stringify(old) ? null : { identity, body: merged }
}

/** A usage-limit failure row decides the ending's outcome; a person's Stop makes it a cancellation. */
export function refineAgentJournalQuotaTurnEnd(
  view: JournalTimelineView,
  turn: AgentJournalItemIdentity,
  failureItemId: string,
  write: AgentJournalTurnRowWrite
): ReturnType<typeof resolveAgentJournalTurnRowWrite> {
  const lifecycle = write.lifecycle
  if (!lifecycle) {
    return null
  }
  const itemId = agentJournalItemKey(turn)
  const row = view.item(failureItemId)
  const quota =
    row?.body.kind === 'status' &&
    isRootAgentJournalItem(row) &&
    row.turnScope?.kind === 'turn' &&
    row.turnScope.turnItemId === itemId &&
    readAgentSessionFailureFact(row.body.failure)?.kind === 'usageLimitReached'
  const stopped =
    lifecycle.completedAt !== undefined &&
    view.stopDecidesTurn(lifecycle.turnId, lifecycle.completedAt)
  const outcome = quota ? (stopped ? 'cancellation' : 'failure') : undefined
  const target = { identity: turn }
  return resolveAgentJournalTurnRowWrite(
    view,
    target,
    { ...write, lifecycle: { ...lifecycle, ...(outcome ? { outcome } : {}) } },
    agentJournalTurnRowReservedBytes(target, write)
  )
}
