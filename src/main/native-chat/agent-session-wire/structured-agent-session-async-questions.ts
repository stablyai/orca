import {
  structuredQuestionImport,
  restoreImportedQuestionMessage
} from './structured-agent-session-question-import'
import type {
  StructuredAgentSessionCurrentWork,
  StructuredAgentSessionCurrentWorkJournal
} from './structured-agent-session-current-work'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { CurrentRequestsPayload } from '../../../shared/agent-session-current-requests-wire'
import {
  isNativeChatContextClear,
  isAgentSessionContextClear
} from '../../../shared/agent-session-context-clear'
import type { MessageQuestionOccurrence } from '../../../shared/message-question-occurrence'
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
  inputKey: string
  payload?: CurrentRequestsPayload
  json?: string
  context: string
  sourceRevision: number
  items: AgentJournalRenderItem[]
  prepare: () => MessageQuestionIngest
  ingest?: MessageQuestionIngest
  nextAttempt?: number
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
  let attempt = prior
  const source = prior?.key === key ? structuredQuestionImport(journal, prior.items) : undefined
  if (prior?.key !== key || (source && source.revision !== prior.sourceRevision)) {
    const all: AgentJournalRenderItem[] = []
    journal.visitItems((id) => {
      const item = journal.item(id)
      if (item) {
        all.push(item)
      }
    })
    all.sort(compareAgentJournalItems)
    const imported = source ?? structuredQuestionImport(journal, all)
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
    const scoped = hostStatesTurnScopes(all)
    const facts = journal.questionSourceFacts()
    const semanticRows = all.filter(
      (item) =>
        item.body.kind === 'turn' ||
        item.body.kind === 'status' ||
        item.body.kind === 'tool-call' ||
        (item.body.kind === 'message' &&
          (item.body.role === 'user' ||
            item.body.role === 'system' ||
            item.body.blocks.some((block) => block.type === 'tool-call')))
    )
    const inputKey = JSON.stringify([
      cursor.epoch,
      imported.revision,
      scoped,
      facts.clearOperationId,
      imported.clearOperationId,
      [...facts.removed],
      [...undelivered],
      semanticRows.map((item) => [item.itemId, item.revision, item.sequence, item.sequenceIndex])
    ])
    if (prior?.inputKey === inputKey) {
      attempt = prior
      attempt.key = key
      attempt.items = all
    } else {
      const messages = new Map(
        projectStructuredItemsToNativeChat(semanticRows).map((message) => [message.id, message])
      )
      const canonicalContext = (record: MessageQuestionOccurrence): string => {
        try {
          const value: unknown = JSON.parse(record.context)
          if (
            Array.isArray(value) &&
            value.length === 2 &&
            value.every((part) => typeof part === 'string')
          ) {
            return value[1]
          }
        } catch {
          /* Current semantic boundaries are ordinary canonical keys. */
        }
        return record.context
      }
      const clearOperationId = facts.clearOperationId ?? imported.clearOperationId
      const clearId = clearOperationId
        ? agentJournalSubmissionKey(`context-clear:${clearOperationId}`)
        : undefined
      const omittedClear = clearId && !all.some((item) => item.itemId === clearId)
      let context = 'root'
      for (const row of imported.boundary?.prefix ?? []) {
        if (
          isNativeChatContextClear(row.message) &&
          !facts.removed.has(facts.canonicalItemId(row.message.id))
        ) {
          context = row.message.id
        }
      }
      if (omittedClear) {
        context = clearId
      }
      const contexts = new Map<string, string>()
      for (const item of all) {
        if (isAgentSessionContextClear(item.body)) {
          context = item.itemId
        }
        contexts.set(item.itemId, context)
      }
      const prepare = () => {
        let precedingTurn: string | null = null
        let replayContext = 'root'
        if (!imported.boundary) {
          throw new Error('Original question source incomplete')
        }
        const owner = journal.messageQuestions()
        const ingest = new MessageQuestionIngest(owner.repository, owner.source, canonicalContext)
        const saved = owner.repository.current(owner.source).records
        if (omittedClear) {
          for (const record of saved) {
            const priorContext = canonicalContext(record)
            if (priorContext !== clearId) {
              ingest.retire(priorContext, { id: clearId, at: null })
            }
          }
        }
        ingest.replace(
          saved
            .filter((record) => facts.removed.has(facts.canonicalItemId(record.sourceRowId)))
            .map((record) => record.id),
          { id: `replacement:${cursor.epoch}`, at: null }
        )
        for (const { message, order } of imported.boundary.prefix) {
          if (facts.removed.has(facts.canonicalItemId(message.id))) {
            continue
          }
          if (isNativeChatContextClear(message)) {
            ingest.retire(replayContext, { id: message.id, at: message.timestamp })
            replayContext = message.id
          }
          ingest.append(message, { context: replayContext, order, turnId: null })
        }
        if (omittedClear) {
          ingest.retire(replayContext, { id: clearId, at: null })
          replayContext = clearId
        }
        // Classify owners before parsing: late stopped work cannot change live raw-ID deduplication.
        for (const item of all) {
          const turn = readAgentJournalTurn(item.body)
          if (!turn || !isRootAgentJournalItem(item)) {
            continue
          }
          const verdict = agentTurnVerdict({
            state: turn.state,
            outcome: readAgentJournalTurnOutcome(turn)
          })
          if (verdict === 'cancellation') {
            ingest.interrupt(item.itemId, {
              id: item.itemId,
              at: turn.completedAt ?? item.observedAt
            })
          }
        }
        for (const item of all) {
          if (isAgentSessionContextClear(item.body)) {
            ingest.retire(replayContext, { id: item.itemId, at: item.observedAt })
            replayContext = item.itemId
          }
          const turn = readAgentJournalTurn(item.body)
          if (turn && isRootAgentJournalItem(item)) {
            precedingTurn = item.itemId
          }
          const turnId =
            item.turnScope?.kind === 'turn'
              ? item.turnScope.turnItemId
              : scoped
                ? null
                : precedingTurn
          const message = messages.get(item.itemId)
          if (message) {
            const fullMessage = restoreImportedQuestionMessage(
              message,
              imported.boundary.full.get(item.itemId)
            )
            ingest.append(
              undelivered.has(message.id) ? { ...fullMessage, unsent: true } : fullMessage,
              {
                context: contexts.get(item.itemId) ?? context,
                order: [item.sequence, item.sequenceIndex ?? 0],
                turnId
              }
            )
          }
        }
        return ingest
      }
      attempt = { key, inputKey, context, prepare, sourceRevision: imported.revision, items: all }
    }
    projections.set(journal, attempt)
  }
  if (!attempt) {
    throw new Error('Current questions source unavailable')
  }
  let pending: CurrentRequestsPayload['asyncQuestions'] = null
  try {
    // Retain the attempt before preparation and ingest before any fallible creation/settlement.
    if (attempt.nextAttempt === undefined || Date.now() >= attempt.nextAttempt) {
      attempt.ingest ??= attempt.prepare()
      pending = attempt.ingest.current().pending
      attempt.nextAttempt = undefined
    }
  } catch {
    // Async acquisition does not take down healthy blocking/history/lifecycle delivery.
    attempt.nextAttempt = Date.now() + 750
  }
  if (attempt.payload?.blocking === blocking && attempt.payload.asyncQuestions === pending) {
    return attempt.payload
  }
  const payload: CurrentRequestsPayload = {
    blocking,
    asyncQuestions: pending,
    context: { sessionId, boundary: attempt.context }
  }
  const json = JSON.stringify(payload)
  const stable = prior?.json === json && prior.payload ? prior.payload : payload
  attempt.payload = stable
  attempt.json = json
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
  if (!projection?.ingest) {
    throw new Error('Current questions unavailable')
  }
  const prior = projection.ingest.current()
  return projection.ingest.cancel(ids, caller, now).pending !== prior.pending
}
