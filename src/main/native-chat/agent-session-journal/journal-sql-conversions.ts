import { setImmediate } from 'node:timers/promises'
import type { JournalSqlOwner } from './journal-sql-owner'
import type { JournalSqlReaderPool } from './journal-sql-reader-pool'
import { compareJournalLegacyChatsWhenIdle } from './journal-sql-legacy-compares'
import { isJournalSqlSourceContentFailure } from './journal-sql-failure'
import { isJournalReaderReplyLimitFailure } from './journal-sql-reader-reply-limit'
import { isDiskAlmostFull } from '../../../shared/diagnostics/perf-notice-signals'

const CONVERSION_EXPANSION = 1.5

export class JournalConversionStorageError extends Error {
  /** False for one chat waiting on more room than it last had: other chats go on. */
  constructor(readonly holdsOthers = true) {
    super('journal conversion deferred for storage')
    this.name = 'JournalConversionStorageError'
  }
}

export function isJournalConversionStorageError(
  error: unknown
): error is JournalConversionStorageError {
  return error instanceof JournalConversionStorageError
}

/** What idle maintenance drives: conversions, and the storage backoff that pauses them. */
export type JournalBackgroundConversions = Pick<
  JournalSqlConversions,
  'ensure' | 'compareLegacyChats' | 'deferred' | 'resumed'
>

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
  // Free bytes each chat started with before it stopped partway, so it never rebuilds the same prefix.
  private readonly stopped = new Map<string, number>()
  private retryAt = 0
  private retryDelay = 60_000
  private closed = false

  constructor(
    private readonly writer: Pick<JournalSqlOwner, 'maintain'>,
    private readonly readers: Pick<
      JournalSqlReaderPool,
      'importState' | 'prepareConversion' | 'database' | 'compareLegacyChat' | 'conversionStorage'
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
    if (!foreground && this.deferred()) {
      throw new JournalConversionStorageError()
    }
    const promotion = new AbortController()
    if (foreground) {
      promotion.abort()
    }
    const result = this.convert(sessionId, promotion.signal)
      .then((epoch) => {
        this.stopped.delete(sessionId)
        if (epoch !== null) {
          if (!foreground) {
            this.retryDelay = 60_000
          }
          this.rememberReady(sessionId, epoch)
        }
        return epoch
      })
      .catch((error: unknown) => {
        if (!foreground && isJournalConversionStorageError(error) && error.holdsOthers) {
          this.retryAt = performance.now() + this.retryDelay
          this.retryDelay = Math.min(this.retryDelay * 2, 60 * 60_000)
        }
        this.noteCopyFailure(sessionId, error)
        throw error
      })
      .finally(() => {
        this.pending.delete(sessionId)
      })
    this.pending.set(sessionId, { promotion, result })
    return result
  }

  /** Whether background conversion waits out a storage backoff. */
  deferred(): boolean {
    return performance.now() < this.retryAt
  }

  /** True once after a storage backoff ends, so idle conversion runs again. */
  resumed(): boolean {
    const resumed = this.retryAt > 0 && !this.deferred()
    if (resumed) {
      this.retryAt = 0
    }
    return resumed
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
    // Measured only for a chat that still converts, so ready chats never read their rows.
    const free = await this.room(promotion, sessionId)
    if (free === null) {
      throw new JournalConversionStorageError()
    }
    if (free <= (this.stopped.get(sessionId) ?? -1)) {
      throw new JournalConversionStorageError(false)
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
        if ((await this.room(promotion)) === null) {
          this.stopped.set(sessionId, free)
          throw new JournalConversionStorageError()
        }
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

  /** Free bytes, or null when background work must stop for space; an opened chat never does. */
  private async room(promotion: AbortSignal, sessionId?: string): Promise<number | null> {
    if (promotion.aborted) {
      return Infinity
    }
    const storage = await this.storage(sessionId).catch((error: unknown) => {
      if (promotion.aborted) {
        return null
      }
      throw error
    })
    if (!storage || promotion.aborted) {
      return Infinity
    }
    const needed =
      sessionId === undefined ? 0 : (storage.remainingBytes ?? Infinity) * CONVERSION_EXPANSION
    return isDiskAlmostFull({ ...storage, freeBytes: storage.freeBytes - needed })
      ? null
      : storage.freeBytes
  }

  /** Only a failed space measure defers; a damaged or missing original keeps its own failure. */
  private async storage(sessionId?: string) {
    const storage = await this.readers.conversionStorage(sessionId)
    if (!storage) {
      throw new JournalConversionStorageError()
    }
    return storage
  }
}
