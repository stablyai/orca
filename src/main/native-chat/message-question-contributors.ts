import type { MessageQuestionOccurrence } from '../../shared/message-question-occurrence'

/** Membership is only the current outgoing segment, never a history of stopped parsers. */
export class MessageQuestionContributors {
  private readonly records = new Map<
    string,
    { record: MessageQuestionOccurrence; context: string }
  >()
  private readonly contexts = new Map<string, Set<string>>()
  private readonly turns = new Map<string, Set<string>>()

  add(record: MessageQuestionOccurrence, boundary: string): void {
    this.remove(record.id)
    if (record.resolution.state !== 'pending') {
      return
    }
    this.records.set(record.id, { record, context: boundary })
    const context = this.contexts.get(boundary) ?? new Set<string>()
    context.add(record.id)
    this.contexts.set(boundary, context)
    if (record.turnId !== null) {
      const turn = this.turns.get(record.turnId) ?? new Set<string>()
      turn.add(record.id)
      this.turns.set(record.turnId, turn)
    }
  }

  remove(id: string): MessageQuestionOccurrence | undefined {
    const entry = this.records.get(id)
    if (!entry) {
      return
    }
    const { record, context: boundary } = entry
    this.records.delete(id)
    const context = this.contexts.get(boundary)
    context?.delete(id)
    if (context?.size === 0) {
      this.contexts.delete(boundary)
    }
    if (record.turnId !== null) {
      const turn = this.turns.get(record.turnId)
      turn?.delete(id)
      if (turn?.size === 0) {
        this.turns.delete(record.turnId)
      }
    }
    return record
  }

  *takeContext(context: string): Generator<MessageQuestionOccurrence> {
    const ids = this.contexts.get(context)
    if (ids) {
      for (const id of ids) {
        const record = this.remove(id)
        if (record) {
          yield record
        }
      }
    }
  }

  *takeTurn(turnId: string): Generator<MessageQuestionOccurrence> {
    const ids = this.turns.get(turnId)
    if (ids) {
      for (const id of ids) {
        const record = this.remove(id)
        if (record) {
          yield record
        }
      }
    }
  }
}
