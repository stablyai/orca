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

export type MessageQuestionRow = {
  context: string
  order: readonly [number, number]
  turnId: string | null
}

/** Source facts are replayable evidence; only the repository owns the saved terminal decisions. */
export class MessageQuestionIngest {
  private readonly scan = createPendingAskScanner()
  private readonly interruptedScans = new Map<string, ReturnType<typeof createPendingAskScanner>>()
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
  private effectiveById: Map<string, MessageQuestionOccurrence>
  private readonly addresses = new Map<string, MessageQuestionOccurrence>()
  private readonly contextAliases = new Map<string, string>()

  constructor(
    readonly repository: MessageQuestionRepository,
    readonly source: MessageQuestionSource,
    canonicalContext?: (record: MessageQuestionOccurrence) => string
  ) {
    this.effective = repository.current(source)
    this.effectiveById = new Map(this.effective.records.map((record) => [record.id, record]))
    if (canonicalContext) {
      for (const record of this.effective.records) {
        const context = canonicalContext(record)
        this.contextAliases.set(record.context, context)
        const key = JSON.stringify([context, record.sourceRowId, record.callSlot])
        const prior = this.addresses.get(key)
        if (
          !prior ||
          (prior.resolution.state === 'pending' && record.resolution.state !== 'pending')
        ) {
          this.addresses.set(key, record)
        }
      }
      for (const record of this.effective.records) {
        const key = JSON.stringify([canonicalContext(record), record.sourceRowId, record.callSlot])
        if (this.addresses.get(key)?.id !== record.id) {
          this.replace([record.id], { id: record.sourceRowId, at: null })
        }
      }
    }
  }

  append(message: NativeChatMessage, row: MessageQuestionRow): readonly string[] {
    const created: string[] = []
    let scan = this.scan
    if (row.turnId !== null && this.interruptedTurns.has(row.turnId)) {
      let owned = this.interruptedScans.get(row.turnId)
      if (!owned) {
        owned = createPendingAskScanner()
        this.interruptedScans.set(row.turnId, owned)
      }
      scan = owned
    }
    if (isInterruptedStatusMessage(message)) {
      const fact = { id: message.id, at: message.timestamp ?? null, order: row.order }
      if (row.turnId === null) {
        this.interruptContext(row.context, fact)
      } else {
        this.interruptedTurns.set(row.turnId, fact)
      }
      if (row.turnId !== null) {
        this.settleDefinitions(scan, row.context, {
          interruptedTurns: this.interruptedTurns,
          interruptedContexts: this.interruptedContexts
        })
      }
      this.dirty = true
    } else if (isDeliveredNativeChatUserMessage(message)) {
      this.deliver(row.context, { id: message.id, at: message.timestamp ?? null, order: row.order })
      if (scan === this.scan) {
        this.interruptedScans.clear()
      }
    }
    for (const contributor of scan.append(message)) {
      const sourceId = messageQuestionSourceId(this.source)
      const established = this.addresses.get(
        JSON.stringify([row.context, contributor.sourceRowId, contributor.callSlot])
      )
      const id =
        established?.id ?? messageQuestionOccurrenceId(this.source, row.context, contributor)
      created.push(id)
      this.definitions.set(id, {
        id,
        sourceId,
        context: established?.context ?? row.context,
        sourceRowId: contributor.sourceRowId,
        callSlot: contributor.callSlot,
        order: [row.order[0], row.order[1]],
        timestamp: contributor.timestamp,
        turnId: row.turnId,
        responseMode: contributor.responseMode,
        questions: contributor.questions,
        resolution: this.definitions.get(id)?.resolution ?? PENDING_MESSAGE_QUESTION
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
      this.settleDefinitions(this.scan, context, {
        interruptedTurns: this.interruptedTurns,
        delivered: this.delivered
      })
      this.dirty = true
    }
  }

  interruptContext(context: string, fact: MessageQuestionDelivery): void {
    this.interruptedContexts.set(context, fact)
    this.settleDefinitions(this.scan, context, {
      interruptedTurns: this.interruptedTurns,
      interruptedContexts: this.interruptedContexts
    })
    this.dirty = true
  }

  retire(context: string, fact: MessageQuestionFact, otherContext?: string): void {
    this.retiredContexts.set(context, fact)
    if (otherContext !== undefined) {
      this.retiredContexts.set(otherContext, fact)
    }
    this.settleDefinitions(this.scan, context, { retiredContexts: this.retiredContexts })
    if (otherContext !== undefined) {
      this.settleDefinitions(this.scan, otherContext, { retiredContexts: this.retiredContexts })
    }
    this.scan.interrupt()
    this.interruptedScans.clear()
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
    this.current()
    if (this.retry) {
      throw new Error('Question changes could not be saved')
    }
    this.setEffective(this.repository.cancel(this.source, ids, caller, now, this.facts()))
    return this.effective
  }

  private setEffective(snapshot: MessageQuestionSnapshot): void {
    if (snapshot === this.effective) {
      return
    }
    this.effective = snapshot
    this.effectiveById = new Map(snapshot.records.map((record) => [record.id, record]))
  }

  private facts() {
    const expand = <T>(facts: ReadonlyMap<string, T>): ReadonlyMap<string, T> => {
      if (!this.contextAliases.size) {
        return facts
      }
      const result = new Map(facts)
      for (const [saved, semantic] of this.contextAliases) {
        const fact = facts.get(semantic)
        if (fact !== undefined) {
          result.set(saved, fact)
        }
      }
      return result
    }
    return {
      delivered: expand(this.delivered),
      interruptedTurns: this.interruptedTurns,
      interruptedContexts: expand(this.interruptedContexts),
      retiredContexts: expand(this.retiredContexts),
      replacedOccurrences: this.replacedOccurrences
    }
  }

  private settleDefinitions(
    scan: ReturnType<typeof createPendingAskScanner>,
    context: string,
    facts: MessageQuestionFacts
  ): void {
    // Preserve ordered terminal outcomes before the scanner abandons these contributors.
    for (const contributor of scan.current().contributors) {
      const established = this.addresses.get(
        JSON.stringify([context, contributor.sourceRowId, contributor.callSlot])
      )
      const id = established?.id ?? messageQuestionOccurrenceId(this.source, context, contributor)
      const definition = this.definitions.get(id) ?? this.effectiveById.get(id)
      if (!definition) {
        continue
      }
      const resolution = reconcileMessageQuestionResolution(
        definition.context === context ? definition : { ...definition, context },
        facts
      )
      if (resolution !== definition.resolution) {
        this.definitions.set(id, { ...definition, resolution })
        this.dirty = true
      }
    }
  }
}
