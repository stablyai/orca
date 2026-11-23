import { setImmediate } from 'node:timers/promises'
import type { JournalSqlOwner } from './journal-sql-owner'
import type { JournalSqlReaderPool } from './journal-sql-reader-pool'
import { compareJournalLegacyChatsWhenIdle } from './journal-sql-legacy-compares'
import { isJournalSqlSourceContentFailure } from './journal-sql-failure'
import { isJournalReaderReplyLimitFailure } from './journal-sql-reader-reply-limit'

type Conversion = { promotion: AbortController; result: Promise<string | null> }

function warnLegacy(step: string, sessionId: string, error: unknown): void {
  console.warn(
    `[agent-session-journal] ${step} a chat an older Orca saved failed`,
    sessionId,
    error
  )
}

/** One lock per chat, shared by background work and opens; promotion wakes a paused conversion. */
export class JournalSqlConversions {
  private readonly pending = new Map<string, Conversion>()
  private readonly ready = new Map<string, string>()
  private closed = false

  constructor(
    private readonly writer: Pick<JournalSqlOwner, 'maintain'>,
    private readonly readers: Pick<
      JournalSqlReaderPool,
      'importState' | 'prepareConversion' | 'database' | 'compareLegacyChat'
    >,
    private readonly waitForIdle: (promotion: AbortSignal) => Promise<void>
  ) {}

  /** Converted chats an older Orca may have continued, compared before idle conversion. */
  compareLegacyChats(boundary: () => Promise<boolean>): Promise<void> {
    return compareJournalLegacyChatsWhenIdle(
      this.writer,
      this.readers,
      boundary,
      () => this.closed,
      (error, sessionId) => warnLegacy('comparing', sessionId, error)
    ).catch((error: unknown) =>
      console.warn('[agent-session-journal] comparing chats an older Orca saved stopped', error)
    )
  }

  async ensure(sessionId: string, foreground = true): Promise<string | null> {
    if (this.closed) {
      throw new Error('journal conversions are closed')
    }
    const ready = this.ready.get(sessionId)
    if (ready !== undefined) {
      return ready
    }
    const pending = this.pending.get(sessionId)
    if (pending) {
      if (foreground) {
        pending.promotion.abort()
      }
      return pending.result
    }
    const promotion = new AbortController()
    if (foreground) {
      promotion.abort()
    }
    const result = this.convert(sessionId, promotion.signal)
      .then((epoch) => {
        if (epoch !== null) {
          this.rememberReady(sessionId, epoch)
        }
        return epoch
      })
      .catch((error: unknown) => {
        this.noteCopyFailure(sessionId, error)
        throw error
      })
      .finally(() => {
        this.pending.delete(sessionId)
      })
    this.pending.set(sessionId, { promotion, result })
    return result
  }

  /** A copy whose original content can't convert or fit a reply is left to an open, never to a quit's rejection. */
  private noteCopyFailure(sessionId: string, error: unknown): void {
    if (
      this.closed ||
      !(isJournalSqlSourceContentFailure(error) || isJournalReaderReplyLimitFailure(error))
    ) {
      return
    }
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500)
    void this.writer
      .maintain({ kind: 'legacy-copy-failed', sessionId, error: message })
      .catch((failure: unknown) => warnLegacy('recording', sessionId, failure))
  }

  /** A ready physical epoch survives context changes for the lifetime of the database owner. */
  rememberReady(sessionId: string, epoch: string): void {
    this.ready.set(sessionId, epoch)
  }

  async close(): Promise<void> {
    this.closed = true
    for (const { promotion } of this.pending.values()) {
      promotion.abort()
    }
    await Promise.allSettled([...this.pending.values()].map(({ result }) => result))
    this.ready.clear()
  }

  private async boundary(promotion: AbortSignal): Promise<void> {
    if (!promotion.aborted) {
      try {
        await this.waitForIdle(promotion)
      } catch (error) {
        if (!promotion.aborted) {
          throw error
        }
      }
    }
    if (this.closed) {
      throw new Error('journal conversions are closed')
    }
    await setImmediate()
  }

  private async convert(sessionId: string, promotion: AbortSignal): Promise<string | null> {
    await this.boundary(promotion)
    const state = await this.readers.importState(sessionId)
    if (state.state === 'ready') {
      return state.epoch
    }
    for (;;) {
      await this.boundary(promotion)
      const discarded = await this.writer.maintain({ kind: 'import-discard', sessionId })
      if (
        !discarded ||
        typeof discarded !== 'object' ||
        !('more' in discarded) ||
        !('epoch' in discarded)
      ) {
        throw new Error('journal writer returned no import discard result')
      }
      if (discarded.epoch !== null) {
        return discarded.epoch
      }
      if (!discarded.more) {
        break
      }
    }
    await this.boundary(promotion)
    const reader = await this.readers.prepareConversion(sessionId)
    if (!reader) {
      return null
    }
    try {
      const { header } = reader
      for (;;) {
        await this.boundary(promotion)
        const page = await reader.next()
        if (!page) {
          break
        }
        // A chat already ready keeps its rows; the frozen source never replaces them.
        if (!(await this.writer.maintain({ kind: 'import-page', target: header, page }))) {
          break
        }
      }
      await this.boundary(promotion)
      const epoch = await this.writer.maintain({ kind: 'import-finish', header })
      if (typeof epoch !== 'string') {
        throw new Error('journal writer returned no imported epoch')
      }
      return epoch
    } finally {
      await reader.close()
    }
  }
}
