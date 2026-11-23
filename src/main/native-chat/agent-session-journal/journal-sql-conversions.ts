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
  'ensure' | 'compareLegacyChats' | 'deferred' | 'resumed' | 'waiting'
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
  // Free bytes a chat that stopped partway needs before it retries, so it never rebuilds the same prefix.
  private readonly stopped = new Map<string, number>()
  // A deferred chat's size, kept until its original changes, so a retry only measures free space.
  private readonly sizes = new Map<string, { sizedAt: string; bytes: number }>()
  private retryAt = 0
  private resumeAt = 0
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
        this.sizes.delete(sessionId)
        if (epoch !== null) {
          if (!foreground) {
            this.retryDelay = 60_000
          }
          this.rememberReady(sessionId, epoch)
        }
        return epoch
      })
      .catch((error: unknown) => {
        if (!foreground && isJournalConversionStorageError(error)) {
          // A chat waiting for more room retries on the same backoff, without holding others.
          this.resumeAt = performance.now() + this.retryDelay
          this.retryAt = error.holdsOthers ? this.resumeAt : this.retryAt
          this.retryDelay = Math.min(this.retryDelay * 2, 60 * 60_000)
        } else {
          this.sizes.delete(sessionId)
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
    const resumed = this.resumeAt > 0 && performance.now() >= this.resumeAt
    if (resumed) {
      this.resumeAt = 0
    }
    return resumed
  }

  /** Chats that stopped partway and wait for more room, retried on their own once it may be there. */
  waiting(): string[] {
    return [...this.stopped.keys()]
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
    const start = await this.room(promotion, sessionId)
    if (start.low) {
      throw new JournalConversionStorageError()
    }
    if (start.freeBytes < (this.stopped.get(sessionId) ?? 0)) {
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
        const now = await this.room(promotion)
        if (now.low) {
          // A retry needs the room this attempt used on top of the room it started with.
          this.stopped.set(sessionId, 2 * start.freeBytes - now.freeBytes)
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

  /** Free bytes, and whether background work must stop for space; an opened chat never does. */
  private async room(
    promotion: AbortSignal,
    sessionId?: string
  ): Promise<{ freeBytes: number; low: boolean }> {
    const open = { freeBytes: Infinity, low: false }
    if (promotion.aborted) {
      return open
    }
    const sized = sessionId === undefined ? undefined : this.sizes.get(sessionId)
    const storage = await this.storage(sessionId, sized?.sizedAt).catch((error: unknown) => {
      if (promotion.aborted) {
        return null
      }
      throw error
    })
    if (!storage || promotion.aborted) {
      return open
    }
    const bytes =
      storage.remainingBytes ??
      (storage.sizedAt !== undefined && storage.sizedAt === sized?.sizedAt ? sized.bytes : Infinity)
    if (sessionId !== undefined && storage.remainingBytes !== undefined && storage.sizedAt) {
      this.sizes.set(sessionId, { sizedAt: storage.sizedAt, bytes: storage.remainingBytes })
    }
    const needed = sessionId === undefined ? 0 : bytes * CONVERSION_EXPANSION
    const low = isDiskAlmostFull({ ...storage, freeBytes: storage.freeBytes - needed })
    return { freeBytes: storage.freeBytes, low }
  }

  /** Only a failed space measure defers; a damaged or missing original keeps its own failure. */
  private async storage(sessionId?: string, sizedAt?: string) {
    const storage = await this.readers.conversionStorage(sessionId, sizedAt)
    if (!storage) {
      throw new JournalConversionStorageError()
    }
    return storage
  }
}
