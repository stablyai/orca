import type { JournalSqlReaderPool } from './journal-sql-reader-pool'
import {
  isJournalConversionStorageError,
  type JournalBackgroundConversions
} from './journal-sql-conversions'

/**
 * The launch pass converting saved chats in the background. Low space ends it where it was until
 * the storage backoff ends, so a resume never walks the chats already converted again.
 */
export class JournalSavedChatConversion {
  // Where the pass resumes after a storage backoff; undefined once it reached the end.
  private convertedThrough: string | null | undefined = null
  // Chats whose estimate didn't fit the room left, retried on the next pass smallest first.
  private skipped: { sessionId: string; needed: number }[] = []

  constructor(
    private readonly readers: Pick<JournalSqlReaderPool, 'database'>,
    private readonly conversions: JournalBackgroundConversions,
    private readonly boundary: () => Promise<boolean>,
    private readonly convert: (sessionId: string) => Promise<unknown>,
    private readonly report: (error: unknown, sessionId?: string) => void
  ) {}

  async run(): Promise<void> {
    // Until one still doesn't fit, so a retry with no new room measures a single chat.
    const retry = this.skipped.splice(0).sort((a, b) => a.needed - b.needed)
    for (const [index, chat] of retry.entries()) {
      const skips = this.skipped.length
      if (!(await this.next(chat.sessionId)) || this.conversions.deferred()) {
        // A full disk ends the pass before this chat, or during it: it is retried with the rest.
        this.skipped.push(...retry.slice(index))
        return
      }
      if (this.skipped.length > skips) {
        this.skipped.push(...retry.slice(index + 1))
        break
      }
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
    if (this.skipped.length === 0) {
      this.conversions.passCompleted()
      return
    }
    this.report(new Error(`journal conversion skipped ${this.skipped.length} chats for storage`))
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
        this.skipped.push({ sessionId, needed: error.needed })
      } else {
        this.report(error, sessionId)
      }
    }
    return true
  }
}
