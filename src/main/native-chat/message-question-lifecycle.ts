import type {
  MessageQuestionOccurrence,
  MessageQuestionResolution
} from '../../shared/message-question-occurrence'

export type MessageQuestionFact = { id: string; at: number | null }
export type MessageQuestionDelivery = MessageQuestionFact & { order: readonly [number, number] }
export type MessageQuestionFacts = {
  delivered?: ReadonlyMap<string, MessageQuestionDelivery>
  interruptedTurns?: ReadonlyMap<string, MessageQuestionFact>
  interruptedContexts?: ReadonlyMap<string, MessageQuestionDelivery>
  retiredContexts?: ReadonlyMap<string, MessageQuestionFact>
  replacedOccurrences?: ReadonlyMap<string, MessageQuestionFact>
}

export function compareMessageQuestionOrder(
  a: readonly [number, number],
  b: readonly [number, number]
): number {
  return a[0] - b[0] || a[1] - b[1]
}

/** Facts settle their causal owner; late old-work rows cannot interrupt newer work. */
export function reconcileMessageQuestionResolution(
  record: MessageQuestionOccurrence,
  facts: MessageQuestionFacts
): MessageQuestionResolution {
  if (record.resolution.state !== 'pending') {
    return record.resolution
  }
  const scopedInterrupt =
    record.turnId === null ? undefined : facts.interruptedTurns?.get(record.turnId)
  const contextInterrupt = facts.interruptedContexts?.get(record.context)
  const interrupt =
    scopedInterrupt ??
    (contextInterrupt && compareMessageQuestionOrder(record.order, contextInterrupt.order) < 0
      ? contextInterrupt
      : undefined)
  const context = facts.retiredContexts?.get(record.context)
  const replacement = facts.replacedOccurrences?.get(record.id)
  const delivery = facts.delivered?.get(record.context)
  const terminal =
    interrupt ??
    context ??
    replacement ??
    (delivery && compareMessageQuestionOrder(record.order, delivery.order) < 0
      ? delivery
      : undefined)
  if (!terminal) {
    return record.resolution
  }
  return {
    state: interrupt || context || replacement ? 'cancelled' : 'resolved',
    reason: interrupt
      ? 'interruption'
      : context
        ? 'context'
        : replacement
          ? 'source-replaced'
          : 'delivery',
    factId: terminal.id,
    resolvedAt: terminal.at,
    resolvedBy: null
  }
}
