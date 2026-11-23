import type { JournalSqlReaderPool } from './journal-sql-reader-pool'
import type { JournalBackgroundConversions } from './journal-sql-conversions'

/**
 * The launch pass converting saved chats in the background. Low space ends it where it was until
 * the storage backoff ends, so a resume never walks the chats already converted again.
 */
export class JournalSavedChatConversion {
  // Where the pass resumes after a storage backoff; undefined once it reached the end.
  private convertedThrough: string | null | undefined = null

  constructor(
    private readonly readers: Pick<JournalSqlReaderPool, 'database'>,
    private readonly conversions: JournalBackgroundConversions,
    private readonly boundary: () => Promise<boolean>,
    private readonly convert: (sessionId: string) => Promise<unknown>,
    private readonly report: (error: unknown, sessionId?: string) => void
  ) {}

  async run(): Promise<void> {
    while (this.convertedThrough !== undefined && (await this.boundary())) {
      const after = this.convertedThrough
      const page = await this.readers.database({ kind: 'sessions', after })
      if (page.kind !== 'sessions') {
        throw new Error('journal reader returned no saved sessions')
      }
      if (page.sessionIds.length === 0) {
        this.convertedThrough = undefined
        this.conversions.passCompleted()
        return
      }
      for (const sessionId of page.sessionIds) {
        if (!(await this.next(sessionId))) {
          return
        }
        this.convertedThrough = this.conversions.deferred() ? this.convertedThrough : sessionId
      }
    }
  }

  /** Converts one chat; false once low space ends the pass, or work stops. */
  private async next(sessionId: string): Promise<boolean> {
    if (this.conversions.deferred() || !(await this.boundary())) {
      return false
    }
    try {
      await this.convert(sessionId)
    } catch (error) {
      this.report(error, sessionId)
    }
    return true
  }
}
