import { MessageQuestionRowRevisions } from './message-question-row-revisions'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { isInterruptedStatusMessage } from '../../shared/native-chat-types'
import { isDeliveredNativeChatUserMessage } from '../../shared/native-chat/input/native-chat-ask'
import {
  PENDING_MESSAGE_QUESTION,
  type MessageQuestionOccurrence
} from '../../shared/message-question-occurrence'
import {
  compareMessageQuestionOrder,
  reconcileMessageQuestionResolution,
  type MessageQuestionDelivery,
  type MessageQuestionFact,
  type MessageQuestionFacts
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
import { MessageQuestionContributors } from './message-question-contributors'
import {
  messageQuestionAddressIndex,
  expandMessageQuestionContextFacts
} from './message-question-address-index'

export type MessageQuestionRow = {
  context: string
  order: readonly [number, number]
  turnId: string | null
}

/** Source facts are replayable evidence; only the repository owns the saved terminal decisions. */
export class MessageQuestionIngest {
  private readonly rows = new MessageQuestionRowRevisions()
  private readonly occurrencesByRow = new Map<string, Set<string>>()
  private readonly rowSlots = new Map<string, Set<string>>()
  private readonly contributorOrders = new Map<string, readonly [number, number]>()
  private readonly isolatedTurns = new Set<string>()
  private readonly active = new MessageQuestionContributors()
  private readonly definitions = new Map<string, MessageQuestionOccurrence>()
  private readonly deliveredIds = new Set<string>()
  private readonly delivered = new Map<string, MessageQuestionDelivery>()
  private readonly interruptedTurns = new Map<string, MessageQuestionFact>()
  private readonly interruptedContexts = new Map<string, MessageQuestionDelivery>()
  private readonly retiredContexts = new Map<string, MessageQuestionFact>()
  private readonly replacedOccurrences = new Map<string, MessageQuestionFact>()
  private dirty = false
  private retry = false
  private pendingState: MessageQuestionSourceState | undefined
  private effective: MessageQuestionSnapshot
  private effectiveById: Map<string, MessageQuestionOccurrence>
  private readonly addressIndex: ReturnType<typeof messageQuestionAddressIndex>

  constructor(
    readonly repository: MessageQuestionRepository,
    readonly source: MessageQuestionSource,
    canonicalContext?: (record: MessageQuestionOccurrence) => string
  ) {
    this.effective = repository.current(source)
    this.effectiveById = new Map(this.effective.records.map((record) => [record.id, record]))
    this.addressIndex = messageQuestionAddressIndex(this.effective.records, canonicalContext)
    for (const record of this.effective.records) {
      this.indexRow(record.sourceRowId, record.id)
    }
    for (const record of this.addressIndex.replaced) {
      this.replace([record.id], { id: record.sourceRowId, at: null })
    }
  }

  append(message: NativeChatMessage, row: MessageQuestionRow): readonly string[] {
    const created: string[] = []
    const parser = row.turnId !== null && this.isolatedTurns.has(row.turnId) ? row.turnId : 'live'
    if (isInterruptedStatusMessage(message)) {
      this.rows.reset(parser)
      const fact = { id: message.id, at: message.timestamp ?? null, order: row.order }
      if (row.turnId === null) {
        this.interruptContext(row.context, fact)
      } else {
        this.interrupt(row.turnId, fact)
      }
      this.dirty = true
    } else if (isDeliveredNativeChatUserMessage(message)) {
      this.deliver(row.context, { id: message.id, at: message.timestamp ?? null, order: row.order })
      this.rows.reset()
    }
    const rowKey = JSON.stringify([row.context, message.id])
    const previousSlots = this.rowSlots.get(rowKey)
    for (const contributor of this.rows.read(message, row.context, parser)) {
      const sourceId = messageQuestionSourceId(this.source)
      const established = this.addressIndex.addresses.get(
        JSON.stringify([row.context, contributor.sourceRowId, contributor.callSlot])
      )
      const id =
        established?.id ?? messageQuestionOccurrenceId(this.source, row.context, contributor)
      created.push(id)
      const previous = this.definitions.get(id) ?? this.effectiveById.get(id) ?? established
      const order = this.contributorOrders.get(id) ?? row.order
      this.contributorOrders.set(id, order)
      const definition: MessageQuestionOccurrence = {
        id,
        sourceId,
        context: established?.context ?? row.context,
        sourceRowId: contributor.sourceRowId,
        callSlot: contributor.callSlot,
        order: [order[0], order[1]],
        timestamp: contributor.timestamp,
        turnId: row.turnId,
        responseMode: contributor.responseMode,
        questions: contributor.questions,
        resolution: previous?.resolution ?? PENDING_MESSAGE_QUESTION
      }
      const resolved = {
        ...definition,
        resolution: reconcileMessageQuestionResolution(
          { ...definition, context: row.context },
          this.rawFacts()
        )
      }
      this.definitions.set(id, resolved)
      this.indexRow(message.id, id)
      this.active.add(resolved, row.context)
      this.dirty = true
    }
    if (previousSlots) {
      const retained = new Set(created)
      this.replace(
        [...previousSlots].filter((id) => !retained.has(id)),
        { id: message.id, at: message.timestamp ?? null }
      )
    }
    this.rowSlots.set(rowKey, new Set(created))
    return created
  }

  removeRow(sourceRowId: string, fact: MessageQuestionFact): void {
    this.replace(this.occurrencesByRow.get(sourceRowId) ?? [], fact)
  }

  private indexRow(sourceRowId: string, id: string): void {
    const ids = this.occurrencesByRow.get(sourceRowId) ?? new Set<string>()
    ids.add(id)
    this.occurrencesByRow.set(sourceRowId, ids)
  }

  isolate(turnId: string): void {
    this.isolatedTurns.add(turnId)
  }

  interrupt(turnId: string, fact: MessageQuestionFact): void {
    this.isolate(turnId)
    if (this.interruptedTurns.has(turnId)) {
      return
    }
    this.interruptedTurns.set(turnId, fact)
    this.settleDefinitions(this.active.takeTurn(turnId), {
      interruptedTurns: new Map([[turnId, fact]])
    })
    this.dirty = true
  }

  deliver(context: string, fact: MessageQuestionDelivery): void {
    const deliveryKey = JSON.stringify([context, fact.id])
    if (this.deliveredIds.has(deliveryKey)) {
      return
    }
    this.deliveredIds.add(deliveryKey)
    const prior = this.delivered.get(context)
    if (!prior || compareMessageQuestionOrder(prior.order, fact.order) < 0) {
      this.delivered.set(context, fact)
      this.settleDefinitions(this.active.takeContext(context), {
        delivered: new Map([[context, fact]])
      })
      this.dirty = true
    }
  }

  interruptContext(context: string, fact: MessageQuestionDelivery): void {
    this.interruptedContexts.set(context, fact)
    this.settleDefinitions(this.active.takeContext(context), {
      interruptedContexts: new Map([[context, fact]])
    })
    this.dirty = true
  }

  retire(context: string, fact: MessageQuestionFact, otherContext?: string): void {
    this.retiredContexts.set(context, fact)
    if (otherContext !== undefined) {
      this.retiredContexts.set(otherContext, fact)
    }
    this.settleDefinitions(this.active.takeContext(context), {
      retiredContexts: this.retiredContexts
    })
    if (otherContext !== undefined) {
      this.settleDefinitions(this.active.takeContext(otherContext), {
        retiredContexts: this.retiredContexts
      })
    }
    this.rows.reset()
    this.dirty = true
  }

  replace(ids: Iterable<string>, fact: MessageQuestionFact): void {
    for (const id of ids) {
      const prior = this.replacedOccurrences.get(id)
      if (prior) {
        continue
      }
      this.replacedOccurrences.set(id, fact)
      const record = this.definitions.get(id) ?? this.effectiveById.get(id)
      if (record) {
        this.settleDefinitions([record], { replacedOccurrences: new Map([[id, fact]]) })
        this.active.remove(id)
      }
    }
    this.dirty = true
  }

  admitSourceState(state?: MessageQuestionSourceState): void {
    this.pendingState = state ?? this.pendingState
  }

  current(state?: MessageQuestionSourceState) {
    this.admitSourceState(state)
    if (!this.dirty && !this.retry && !this.pendingState) {
      return this.effective
    }
    const result = this.repository.reconcile(
      this.source,
      [...this.definitions.values()],
      this.dirty || this.retry ? this.facts() : {},
      this.pendingState
    )
    this.setEffective(result.snapshot)
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
    const targets = new Map(
      ids.map((id) => [id, this.definitions.get(id) ?? this.effectiveById.get(id)])
    )
    const committed = this.repository.cancel(this.source, ids, caller, now, this.facts(), targets)
    for (const record of committed) {
      this.active.remove(record.id)
      this.effectiveById.set(record.id, record)
      const staged = this.definitions.get(record.id)
      if (staged) {
        this.definitions.set(record.id, { ...staged, resolution: record.resolution })
      }
    }
    if (committed.length) {
      // The next resource read repairs the full projection; the action returns only its target receipt.
      this.retry = true
    }
    return committed
  }

  private setEffective(snapshot: MessageQuestionSnapshot): void {
    if (snapshot === this.effective) {
      return
    }
    this.effective = snapshot
    this.effectiveById = new Map(snapshot.records.map((record) => [record.id, record]))
  }

  private rawFacts(): MessageQuestionFacts {
    return {
      delivered: this.delivered,
      interruptedTurns: this.interruptedTurns,
      interruptedContexts: this.interruptedContexts,
      retiredContexts: this.retiredContexts,
      replacedOccurrences: this.replacedOccurrences
    }
  }

  private facts() {
    const aliases = this.addressIndex.contextAliases
    return {
      delivered: expandMessageQuestionContextFacts(aliases, this.delivered),
      interruptedTurns: this.interruptedTurns,
      interruptedContexts: expandMessageQuestionContextFacts(aliases, this.interruptedContexts),
      retiredContexts: expandMessageQuestionContextFacts(aliases, this.retiredContexts),
      replacedOccurrences: this.replacedOccurrences
    }
  }

  private settleDefinitions(
    records: Iterable<MessageQuestionOccurrence>,
    facts: MessageQuestionFacts
  ): void {
    for (const record of records) {
      const definition =
        this.definitions.get(record.id) ?? this.effectiveById.get(record.id) ?? record
      const context = this.addressIndex.contextAliases.get(definition.context) ?? definition.context
      const resolution = reconcileMessageQuestionResolution({ ...definition, context }, facts)
      if (resolution !== definition.resolution) {
        this.definitions.set(record.id, { ...definition, resolution })
        this.dirty = true
      }
    }
  }
}
