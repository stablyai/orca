import type { JournalPersistenceEffect } from './journal-persistence-plan'
import { appendJournalUnitPacket, type JournalUnitPacket } from './journal-unit-transfer'

/** Both native owners stage bounded packets before opening their SQLite transaction. */
export class JournalUnitUpload {
  private readonly effects = new Map<number, JournalPersistenceEffect>()

  clear(): void {
    this.effects.clear()
  }

  append(packets: readonly JournalUnitPacket[]): void {
    for (const { index, effect } of packets) {
      if (!Number.isSafeInteger(index) || index < 0 || index > this.effects.size) {
        throw new Error('Journal upload order is invalid')
      }
      const current = this.effects.get(index)
      if (current) {
        appendJournalUnitPacket(current, effect)
      } else {
        this.effects.set(index, structuredClone(effect))
      }
    }
  }

  take(count: number): JournalPersistenceEffect[] {
    if (!Number.isSafeInteger(count) || count < 0 || this.effects.size !== count) {
      throw new Error('Journal upload is incomplete')
    }
    const effects = Array.from({ length: count }, (_, index) => {
      const effect = this.effects.get(index)
      if (!effect) {
        throw new Error('Journal upload is incomplete')
      }
      return effect
    })
    this.clear()
    return effects
  }
}
