import { createHash } from 'node:crypto'
import type { JournalReturnedCard } from '../native-chat/agent-session-journal/journal-domain-queue-reads'

// An unchanged prefix of broken cards must not spend every delivery's file inspection budget.
type MissingPrefix = { count: number; digest: string }

export class ReturnedImageProgress {
  private readonly prefixes = new Map<string, MissingPrefix>()

  read(key: string, eligible: readonly JournalReturnedCard[]): number {
    const prefix = this.prefixes.get(key)
    if (
      prefix &&
      prefix.count <= eligible.length &&
      this.digest(eligible, prefix.count) === prefix.digest
    ) {
      return prefix.count
    }
    this.prefixes.delete(key)
    return 0
  }

  remember(key: string, eligible: readonly JournalReturnedCard[], count: number): void {
    this.prefixes.delete(key)
    this.prefixes.set(key, {
      count,
      digest: this.digest(eligible, count)
    })
    if (this.prefixes.size > 8192) {
      const oldest = this.prefixes.keys().next()
      if (!oldest.done) {
        this.prefixes.delete(oldest.value)
      }
    }
  }

  clear(): void {
    this.prefixes.clear()
  }

  private digest(eligible: readonly JournalReturnedCard[], count: number): string {
    const hash = createHash('sha256')
    for (let index = 0; index < count; index += 1) {
      const { messageId, fingerprint } = eligible[index]!.card
      hash.update(JSON.stringify([messageId, fingerprint]))
    }
    return hash.digest('hex')
  }
}
