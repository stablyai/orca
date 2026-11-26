import { createHash } from 'node:crypto'
import type { JournalReturnedCard } from '../native-chat/agent-session-journal/journal-domain-queue-reads'

// An unchanged prefix of broken cards must not spend every delivery's file inspection budget.
type MissingPrefix = { count: number; digest: string; expiresAt: number; resume: boolean }

export class ReturnedImageProgress {
  private readonly prefixes = new Map<string, MissingPrefix>()

  read(key: string, eligible: readonly JournalReturnedCard[], now: number): number {
    const prefix = this.prefixes.get(key)
    if (
      prefix &&
      (prefix.resume || now < prefix.expiresAt) &&
      prefix.count <= eligible.length &&
      this.digest(eligible, prefix.count) === prefix.digest
    ) {
      return prefix.count
    }
    this.prefixes.delete(key)
    return 0
  }

  remember(
    key: string,
    eligible: readonly JournalReturnedCard[],
    count: number,
    missingUntil: number,
    resume: boolean
  ): void {
    const previous = this.prefixes.get(key)
    const expiresAt = Math.min(previous?.expiresAt ?? Infinity, missingUntil)
    if (!Number.isFinite(expiresAt)) {
      return
    }
    if (
      previous?.count === count &&
      previous.resume === resume &&
      previous.expiresAt === expiresAt
    ) {
      return
    }
    this.prefixes.delete(key)
    this.prefixes.set(key, {
      count,
      expiresAt,
      resume,
      digest: previous?.count === count ? previous.digest : this.digest(eligible, count)
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
