import type { JournalSqlReaderPool } from './journal-sql-reader-pool'
import {
  isJournalConversionStorageError,
  type JournalBackgroundConversions
} from './journal-sql-conversions'

/**
 * The launch pass converting saved chats in the background. Low space ends it where it was until
 * the storage backoff ends, so a resume never walks the chats already converted again.
 */
type Skipped = { sessionId: string; needed: number }

export class JournalSavedChatConversion {
  // Where the pass resumes after a storage backoff; undefined once it reached the end.
  private convertedThrough: string | null | undefined = null
  // Chats whose estimate didn't fit the room left, sorted smallest first and retried from `head`;
  // `fresh` holds this pass's skips until it ends, so a retry never re-sorts or copies the list.
  private skipped: Skipped[] = []
  private head = 0
  private fresh: Skipped[] = []

  constructor(
    private readonly readers: Pick<JournalSqlReaderPool, 'database'>,
    private readonly conversions: JournalBackgroundConversions,
    private readonly boundary: () => Promise<boolean>,
    private readonly convert: (sessionId: string) => Promise<unknown>,
    private readonly report: (error: unknown, sessionId?: string) => void
  ) {}

  async run(): Promise<void> {
    // Until one still doesn't fit, so a retry with no new room measures a single chat.
    while (this.head < this.skipped.length) {
      const skips = this.fresh.length
      // A full disk ends the pass before this chat, or during it: it stays at the head.
      if (!(await this.next(this.skipped[this.head]!.sessionId)) || this.conversions.deferred()) {
        return
      }
      if (this.fresh.length > skips) {
        this.fresh.pop()
        break
      }
      this.head++
    }
    while (this.convertedThrough !== undefined && (await this.boundary())) {
      const after = this.convertedThrough
      const page = await this.readers.database({ kind: 'sessions', after })
      if (page.kind !== 'sessions') {
        throw new Error('journal reader returned no saved sessions')
      }
      if (page.sessionIds.length === 0) {
        this.convertedThrough = undefined
        break
      }
      for (const sessionId of page.sessionIds) {
        if (!(await this.next(sessionId))) {
          return
        }
        this.convertedThrough = this.conversions.deferred() ? this.convertedThrough : sessionId
      }
    }
    if (this.convertedThrough === undefined && !this.conversions.deferred()) {
      this.finish()
    }
  }

  /** One line for the chats a pass skipped, which then run again on the backoff. */
  private finish(): void {
    if (this.fresh.length > 0 || this.head >= this.skipped.length) {
      const waiting = this.skipped.slice(this.head).concat(this.fresh)
      this.skipped = waiting.sort((a, b) => a.needed - b.needed)
      this.head = 0
      this.fresh = []
    }
    const count = this.skipped.length - this.head
    if (count === 0) {
      this.conversions.passCompleted()
      return
    }
    this.report(new Error(`journal conversion skipped ${count} chats for storage`))
    this.conversions.deferPass()
  }

  /** Converts one chat; false once low space ends the pass, or work stops. */
  private async next(sessionId: string): Promise<boolean> {
    if (this.conversions.deferred() || !(await this.boundary())) {
      return false
    }
    try {
      await this.convert(sessionId)
    } catch (error) {
      if (isJournalConversionStorageError(error) && error.skipped) {
        this.fresh.push({ sessionId, needed: error.needed })
      } else {
        this.report(error, sessionId)
      }
    }
    return true
  }
}
