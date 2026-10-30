import type {
  StructuredAgentSessionCurrentWork,
  StructuredAgentSessionCurrentWorkJournal
} from './structured-agent-session-current-work'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { CurrentRequestsPayload } from '../../../shared/agent-session-current-requests-wire'
import { isAgentSessionContextClear } from '../../../shared/agent-session-context-clear'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { compareAgentJournalItems } from '../../../shared/agent-session-journal-position'
import { projectStructuredItemsToNativeChat } from '../../../shared/structured-agent-session-projection'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../../../shared/agent-session-turn-record'
import { agentTurnVerdict } from '../../../shared/agent-turn-outcome'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import { hostStatesTurnScopes } from '../../../shared/native-chat-turn-membership'
import { MessageQuestionIngest } from '../message-question-ingest'

type Projection = {
  key: string
  payload: CurrentRequestsPayload
  json: string
  ingest: MessageQuestionIngest
}
const projections = new WeakMap<StructuredAgentSessionCurrentWorkJournal, Projection>()

/** One canonical source pass per journal revision; delivery/Stop belong to their context and work. */
export function structuredAsyncQuestions(
  journal: StructuredAgentSessionCurrentWorkJournal,
  sessionId: string,
  work: StructuredAgentSessionCurrentWork
): CurrentRequestsPayload {
  const cursor = journal.cursor()
  const blocking = work.actionablePrompts()
  const key = `${sessionId}:${cursor.epoch}:${cursor.sequence}`
  const prior = projections.get(journal)
  let ingest = prior?.ingest
  let context = prior?.payload.context.boundary ?? 'root'
  if (prior?.key !== key || !ingest) {
    const owner = journal.messageQuestions()
    ingest = new MessageQuestionIngest(owner.repository, owner.source)
    const all: AgentJournalRenderItem[] = []
    journal.visitItems((id) => {
      const item = journal.item(id)
      if (item) {
        all.push(item)
      }
    })
    all.sort(compareAgentJournalItems)
    const submissions = journal.submissions()
    const undelivered = new Set(
      submissions.flatMap((send) =>
        send.dispatchState === 'accepted'
          ? []
          : [
              agentJournalSubmissionKey(send.clientMessageId),
              ...(send.providerItemId ? [send.providerItemId] : [])
            ]
      )
    )
    const messages = new Map(
      projectStructuredItemsToNativeChat(all).map((message) => [message.id, message])
    )
    const scoped = hostStatesTurnScopes(all)
    let precedingTurn: string | null = null
    context = 'root'
    for (const item of all) {
      if (isAgentSessionContextClear(item.body)) {
        ingest.retire(context, { id: item.itemId, at: item.observedAt })
        context = item.itemId
      }
      const turn = readAgentJournalTurn(item.body)
      if (turn && isRootAgentJournalItem(item)) {
        precedingTurn = item.itemId
        const verdict = agentTurnVerdict({
          state: turn.state,
          outcome: readAgentJournalTurnOutcome(turn)
        })
        if (verdict === 'cancellation' || verdict === 'interruption') {
          ingest.interrupt(item.itemId, {
            id: item.itemId,
            at: turn.completedAt ?? item.observedAt
          })
        }
      }
      const turnId =
        item.turnScope?.kind === 'turn' ? item.turnScope.turnItemId : scoped ? null : precedingTurn
      const message = messages.get(item.itemId)
      if (message) {
        ingest.append(undelivered.has(message.id) ? { ...message, unsent: true } : message, {
          context,
          order: [item.sequence, item.sequenceIndex ?? 0],
          turnId
        })
      }
    }
  }
  // Retrying canonical settlement is required even when the source cursor has not changed.
  const pending = ingest.current().pending
  if (
    prior?.key === key &&
    prior.payload.blocking === blocking &&
    prior.payload.asyncQuestions === pending
  ) {
    return prior.payload
  }
  const payload: CurrentRequestsPayload = {
    blocking,
    asyncQuestions: pending,
    context: { sessionId, boundary: context }
  }
  const json = JSON.stringify(payload)
  const stable = prior?.json === json ? prior.payload : payload
  projections.set(journal, { key, payload: stable, json, ingest })
  return stable
}

export function cancelStructuredAsyncQuestions(
  journal: StructuredAgentSessionCurrentWorkJournal,
  sessionId: string,
  work: StructuredAgentSessionCurrentWork,
  ids: readonly string[],
  caller: string,
  now: number
): boolean {
  structuredAsyncQuestions(journal, sessionId, work)
  const projection = projections.get(journal)
  if (!projection) {
    throw new Error('Current questions unavailable')
  }
  const prior = projection.ingest.current()
  return projection.ingest.cancel(ids, caller, now).pending !== prior.pending
}
