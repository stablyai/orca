import {
  questionDependency,
  unchangedQuestionDependencies
} from './structured-agent-session-question-dependencies'
import {
  structuredQuestionImport,
  restoreImportedQuestionMessage
} from './structured-agent-session-question-import'
import type { StructuredAgentSessionCurrentWorkJournal } from './structured-agent-session-current-work'
import type {
  AgentJournalCursor,
  AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import type { CurrentRequestsPayload } from '../../../shared/agent-session-current-requests-wire'
import {
  isNativeChatContextClear,
  isAgentSessionContextClear
} from '../../../shared/agent-session-context-clear'
import type { MessageQuestionOccurrence } from '../../../shared/message-question-occurrence'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { compareAgentJournalItems } from '../../../shared/agent-session-journal-position'
import { projectStructuredItemToNativeChat } from '../../../shared/structured-agent-session-projection'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../../../shared/agent-session-turn-record'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import { hostStatesTurnScopes } from '../../../shared/native-chat-turn-membership'
import { MessageQuestionIngest } from '../message-question-ingest'
import { agentTurnVerdict } from '../../../shared/agent-turn-outcome'
import type { QuestionImportItem } from './structured-agent-session-question-import-boundary'

type Projection = {
  key: string
  cursor: AgentJournalCursor
  dependencies: Map<string, string>
  scoped: boolean
  payload?: CurrentRequestsPayload
  json?: string
  context: string
  sourceRevision: number
  items: QuestionImportItem[]
  prepare: () => MessageQuestionIngest
  ingest?: MessageQuestionIngest
  nextAttempt?: number
}
const projections = new WeakMap<StructuredAgentSessionCurrentWorkJournal, Projection>()

/** Reuse ordered canonical preparation independently of pending-set storage. */
export function prepareStructuredQuestions(
  journal: StructuredAgentSessionCurrentWorkJournal,
  sessionId: string
): { attempt: Projection; prior: Projection | undefined } {
  const cursor = journal.cursor()
  const key = `${sessionId}:${cursor.epoch}:${cursor.sequence}`
  const prior = projections.get(journal)
  let attempt = prior
  const source = prior ? structuredQuestionImport(journal, prior.items) : undefined
  if (
    prior &&
    source?.revision === prior.sourceRevision &&
    prior.key !== key &&
    unchangedQuestionDependencies(journal, prior.cursor, cursor, prior.dependencies, prior.scoped)
  ) {
    prior.key = key
    prior.cursor = cursor
  }
  if (prior?.key !== key || (source && source.revision !== prior.sourceRevision)) {
    const all: AgentJournalRenderItem[] = []
    journal.visitItems((id) => {
      const item = journal.item(id)
      if (item) {
        all.push(item)
      }
    })
    all.sort(compareAgentJournalItems)
    const facts = journal.questionSourceFacts()
    const sourceItems = facts.inputs.flatMap((input) => (input.kind === 'item' ? [input.item] : []))
    const originals: QuestionImportItem[] = [
      ...all.map((item) => ({ item, fence: journal.itemFence(item.itemId) })),
      ...facts.inputs.flatMap((input) =>
        input.kind === 'item' ? [{ item: input.item, fence: input.fence }] : []
      )
    ]
    const imported = structuredQuestionImport(journal, originals)
    const scoped = hostStatesTurnScopes(sourceItems)
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
    const omittedClear = clearId && !sourceItems.some((item) => item.itemId === clearId)
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
    for (const item of sourceItems) {
      if (isAgentSessionContextClear(item.body)) {
        context = item.itemId
      }
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
      // Final parser classification is independent from the genuine ordered terminal boundaries.
      for (const item of sourceItems) {
        const turn = readAgentJournalTurn(item.body)
        if (
          turn &&
          isRootAgentJournalItem(item) &&
          agentTurnVerdict({ state: turn.state, outcome: readAgentJournalTurnOutcome(turn) }) ===
            'cancellation'
        ) {
          ingest.isolate(item.itemId)
        }
      }
      const stopped = new Set<string>()
      const cleared = new Set<string>()
      for (const input of facts.inputs) {
        if (input.kind === 'remove') {
          ingest.removeRow(input.itemId, { id: input.itemId, at: input.at })
          continue
        }
        const { item } = input
        if (isAgentSessionContextClear(item.body) && !cleared.has(item.itemId)) {
          ingest.retire(replayContext, { id: item.itemId, at: item.observedAt })
          replayContext = item.itemId
          cleared.add(item.itemId)
        }
        const turn = readAgentJournalTurn(item.body)
        if (turn && isRootAgentJournalItem(item)) {
          precedingTurn = item.itemId
          if (
            !stopped.has(item.itemId) &&
            agentTurnVerdict({ state: turn.state, outcome: readAgentJournalTurnOutcome(turn) }) ===
              'cancellation'
          ) {
            ingest.interrupt(item.itemId, {
              id: item.itemId,
              at: turn.completedAt ?? item.observedAt
            })
            stopped.add(item.itemId)
          }
        }
        const turnId =
          item.turnScope?.kind === 'turn'
            ? item.turnScope.turnItemId
            : scoped
              ? null
              : precedingTurn
        const message = projectStructuredItemToNativeChat(item)
        if (message) {
          const fullMessage = restoreImportedQuestionMessage(
            message,
            imported.boundary.full.get(item.itemId)
          )
          ingest.append(input.unsent ? { ...fullMessage, unsent: true } : fullMessage, {
            context: replayContext,
            order: [item.sequence, item.sequenceIndex ?? 0],
            turnId
          })
        }
      }
      return ingest
    }
    attempt = {
      key,
      cursor,
      scoped,
      dependencies: new Map(all.map((item) => [item.itemId, questionDependency(item)])),
      context,
      prepare,
      sourceRevision: imported.revision,
      items: originals
    }
    projections.set(journal, attempt)
  }
  if (!attempt) {
    throw new Error('Current questions source unavailable')
  }
  return { attempt, prior }
}
