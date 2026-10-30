import type { NativeChatMessage } from '../../shared/native-chat-types'
import { isInterruptedStatusMessage } from '../../shared/native-chat-types'
import {
  createPendingAskScanner,
  isDeliveredNativeChatUserMessage
} from '../../shared/native-chat/input/native-chat-ask'
import {
  PENDING_MESSAGE_QUESTION,
  type MessageQuestionOccurrence
} from '../../shared/message-question-occurrence'
import {
  compareMessageQuestionOrder,
  type MessageQuestionDelivery,
  type MessageQuestionFact
} from './message-question-lifecycle'
import {
  messageQuestionOccurrenceId,
  messageQuestionSourceId,
  type MessageQuestionSource,
  type MessageQuestionSourceState
} from './message-question-source'
import type {
  MessageQuestionRepository,
  MessageQuestionSnapshot
} from './message-question-repository'

export type MessageQuestionRow = {
  context: string
  order: readonly [number, number]
  turnId: string | null
}

/** Source facts are replayable evidence; only the repository owns the saved terminal decisions. */
export class MessageQuestionIngest {
  private readonly scan = createPendingAskScanner()
  private readonly definitions = new Map<string, MessageQuestionOccurrence>()
  private readonly delivered = new Map<string, MessageQuestionDelivery>()
  private readonly interruptedTurns = new Map<string, MessageQuestionFact>()
  private readonly interruptedContexts = new Map<string, MessageQuestionDelivery>()
  private readonly retiredContexts = new Map<string, MessageQuestionFact>()
  private readonly replacedOccurrences = new Map<string, MessageQuestionFact>()
  private dirty = false
  private retry = false
  private pendingState: MessageQuestionSourceState | undefined
  private effective: MessageQuestionSnapshot

  constructor(
    readonly repository: MessageQuestionRepository,
    readonly source: MessageQuestionSource
  ) {
    this.effective = repository.current(source)
  }

  append(message: NativeChatMessage, row: MessageQuestionRow): readonly string[] {
    const created: string[] = []
    if (isInterruptedStatusMessage(message)) {
      const fact = { id: message.id, at: message.timestamp ?? null, order: row.order }
      if (row.turnId === null) {
        this.interruptContext(row.context, fact)
      } else {
        this.interruptedTurns.set(row.turnId, fact)
      }
      this.dirty = true
    } else if (isDeliveredNativeChatUserMessage(message)) {
      this.deliver(row.context, { id: message.id, at: message.timestamp ?? null, order: row.order })
    }
    for (const contributor of this.scan.append(message)) {
      const sourceId = messageQuestionSourceId(this.source)
      const id = messageQuestionOccurrenceId(
        sourceId,
        row.context,
        contributor.sourceRowId,
        contributor.callSlot
      )
      created.push(id)
      this.definitions.set(id, {
        id,
        sourceId,
        context: row.context,
        sourceRowId: contributor.sourceRowId,
        callSlot: contributor.callSlot,
        order: [row.order[0], row.order[1]],
        timestamp: contributor.timestamp,
        turnId: row.turnId,
        responseMode: contributor.responseMode,
        questions: contributor.questions,
        resolution: PENDING_MESSAGE_QUESTION
      })
      this.dirty = true
    }
    return created
  }

  interrupt(turnId: string, fact: MessageQuestionFact): void {
    this.interruptedTurns.set(turnId, fact)
    this.dirty = true
  }

  deliver(context: string, fact: MessageQuestionDelivery): void {
    const prior = this.delivered.get(context)
    if (!prior || compareMessageQuestionOrder(prior.order, fact.order) < 0) {
      this.delivered.set(context, fact)
      this.dirty = true
    }
  }

  interruptContext(context: string, fact: MessageQuestionDelivery): void {
    this.interruptedContexts.set(context, fact)
    this.dirty = true
  }

  retire(context: string, fact: MessageQuestionFact): void {
    this.retiredContexts.set(context, fact)
    this.dirty = true
  }

  replace(ids: Iterable<string>, fact: MessageQuestionFact): void {
    for (const id of ids) {
      this.replacedOccurrences.set(id, fact)
    }
    this.dirty = true
  }

  current(state?: MessageQuestionSourceState) {
    if (!this.dirty && !this.retry && !state) {
      return this.effective
    }
    this.pendingState = state ?? this.pendingState
    const result = this.repository.reconcile(
      this.source,
      [...this.definitions.values()],
      this.dirty || this.retry ? this.facts() : {},
      this.pendingState
    )
    this.effective = result.snapshot
    this.retry = result.writeError !== undefined
    if (!this.retry) {
      this.dirty = false
      this.definitions.clear()
      this.pendingState = undefined
    }
    if (result.incomplete) {
      throw result.writeError
    }
    return this.effective
  }

  cancel(ids: readonly string[], caller: string, now: number) {
    this.current()
    if (this.retry) {
      throw new Error('Question changes could not be saved')
    }
    this.effective = this.repository.cancel(this.source, ids, caller, now, this.facts())
    return this.effective
  }

  private facts() {
    return {
      delivered: this.delivered,
      interruptedTurns: this.interruptedTurns,
      interruptedContexts: this.interruptedContexts,
      retiredContexts: this.retiredContexts,
      replacedOccurrences: this.replacedOccurrences
    }
  }
}
