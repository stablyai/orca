import type { WorkerThreadFactory } from '../lazy-worker-thread-host'
import { WorkerThreadRequestQueue } from '../worker-thread-request-queue'
import {
  cursorProfileReadFailure,
  parseCursorProfileReadResult,
  type CursorDesktopProfileReadResult
} from './cursor-profile-result'
import {
  openCodeBinderSessionsFailure,
  parseOpenCodeBinderSessions,
  type BinderSessionRow,
  type OpenCodeSessionCursor
} from './opencode-binder-sessions-result'
import type {
  ForeignSqliteReaderKind,
  ForeignSqliteReaderRequest,
  ForeignSqliteReaderResponse
} from './foreign-sqlite-reader-protocol'

// Why: an open of another app's database can block for seconds on a large -wal,
// so it never runs on the main thread. Each reader gets its own lazily started
// thread (all from one factory) so a slow database delays only its own reader.

// Limits from the dedicated Cursor worker this replaces (#24572).
const READ_TIMEOUT_MS: Record<ForeignSqliteReaderKind, number> = {
  // Covers the 4-6 s WAL-index rebuild reported in #24360 with margin.
  cursorProfile: 10_000,
  openCodeBinderSessions: 60_000
}
// Why per reader: a thread torn down between a poller's rounds is respawned every round.
const DEFAULT_IDLE_TEARDOWN_MS: Record<ForeignSqliteReaderKind, number> = {
  cursorProfile: 30_000,
  // The OpenCode binder polls every 60 s.
  openCodeBinderSessions: 120_000
}
const MAX_CONSECUTIVE_DEATHS = 2
// Reads are deduped per key, so a backlog past this is pile-up, not demand.
const MAX_QUEUED_READS = 8

type LaneSettings = {
  workerFactory: WorkerThreadFactory
  log: (message: string) => void
  timeoutMs: number
  idleTeardownMs: number
}

/** One reader's thread plus its in-flight reads, keyed by what they read. */
export class ForeignSqliteReaderLane<T> {
  private readonly queue: WorkerThreadRequestQueue<
    ForeignSqliteReaderRequest,
    ForeignSqliteReaderResponse
  >
  private readonly inFlight = new Map<string, Promise<T>>()

  constructor(
    private readonly kind: ForeignSqliteReaderKind,
    private readonly parse: (value: unknown) => T | null,
    private readonly failure: () => T,
    private readonly settings: LaneSettings
  ) {
    this.queue = new WorkerThreadRequestQueue({
      factory: settings.workerFactory,
      idleTeardownMs: settings.idleTeardownMs,
      maxConsecutiveDeaths: MAX_CONSECUTIVE_DEATHS,
      queueCap: {
        maxQueuedCalls: MAX_QUEUED_READS,
        describeFull: () => `Foreign SQLite reader ${kind} queue is full`
      },
      // A timed-out read can still be inside SQLite; never start a second thread beside it.
      awaitRetirement: true,
      createUnavailableError: (message) => new Error(message),
      describeTimeout: (ms) => `Foreign SQLite reader ${kind} timed out after ${ms}ms`,
      describeExit: (code) => `Foreign SQLite reader ${kind} exited with code ${code}`,
      describeCrashLoop: (lastError) =>
        `Foreign SQLite reader ${kind} crashed repeatedly (${lastError})`,
      onUnavailable: (err) =>
        settings.log(`Foreign SQLite reader ${kind} worker unavailable: ${errorText(err)}`)
    })
  }

  /**
   * Read one database on this reader's thread.
   * @param key - Concurrent reads with one key share a request, so it must cover every input the result depends on.
   * @param buildRequest - Builds the request around the queue's correlation id.
   * @returns The parsed value, or the reader's failure value if the worker cannot answer.
   */
  read(key: string, buildRequest: (id: number) => ForeignSqliteReaderRequest): Promise<T> {
    const pending = this.inFlight.get(key)
    if (pending) {
      return pending
    }
    const read = this.dispatch(buildRequest).finally(() => {
      this.inFlight.delete(key)
    })
    this.inFlight.set(key, read)
    return read
  }

  dispose(): void {
    this.queue.dispose()
    this.inFlight.clear()
  }

  private async dispatch(buildRequest: (id: number) => ForeignSqliteReaderRequest): Promise<T> {
    const { kind, settings } = this
    try {
      const response = await this.queue.dispatch(buildRequest, settings.timeoutMs)
      if (!response.ok) {
        settings.log(`Foreign SQLite reader ${kind} failed: ${response.error}`)
        return this.failure()
      }
      const value = this.parse(response.value)
      if (value === null) {
        settings.log(`Foreign SQLite reader ${kind} returned a malformed result.`)
        return this.failure()
      }
      return value
    } catch (err) {
      // Timeout, crash, or no worker: never retried on the main thread.
      settings.log(`Foreign SQLite reader ${kind} did not answer: ${errorText(err)}`)
      return this.failure()
    }
  }
}

export class ForeignSqliteReaderClient {
  private readonly cursorProfile: ForeignSqliteReaderLane<CursorDesktopProfileReadResult>
  private readonly openCodeBinderSessions: ForeignSqliteReaderLane<BinderSessionRow[]>

  constructor(options: {
    workerFactory: WorkerThreadFactory
    log?: (message: string) => void
    timeoutMs?: number
    idleTeardownMs?: Partial<Record<ForeignSqliteReaderKind, number>>
  }) {
    const settings = (kind: ForeignSqliteReaderKind): LaneSettings => ({
      workerFactory: options.workerFactory,
      log: options.log ?? ((message: string) => console.warn(message)),
      timeoutMs: options.timeoutMs ?? READ_TIMEOUT_MS[kind],
      idleTeardownMs: options.idleTeardownMs?.[kind] ?? DEFAULT_IDLE_TEARDOWN_MS[kind]
    })
    this.cursorProfile = new ForeignSqliteReaderLane(
      'cursorProfile',
      parseCursorProfileReadResult,
      cursorProfileReadFailure,
      settings('cursorProfile')
    )
    this.openCodeBinderSessions = new ForeignSqliteReaderLane(
      'openCodeBinderSessions',
      parseOpenCodeBinderSessions,
      openCodeBinderSessionsFailure,
      settings('openCodeBinderSessions')
    )
  }

  /**
   * Read the Cursor IDE's stored session off the main thread.
   * @param dbPath - Cursor's state.vscdb.
   * @returns The reader's result; its failure value when the worker cannot answer.
   */
  readCursorProfile(dbPath: string): Promise<CursorDesktopProfileReadResult> {
    // The request is the path alone, so the path is the whole key.
    return this.cursorProfile.read(dbPath, (id) => ({ id, kind: 'cursorProfile', dbPath }))
  }

  /**
   * List OpenCode 1 sessions newer than `cursor` off the main thread.
   * @param dbPath - The shared server's opencode.db.
   * @param cursor - Store position the binder has handled up to.
   * @returns Rows oldest first; `[]` when the store or the worker cannot answer.
   */
  readOpenCodeBinderSessions(
    dbPath: string,
    cursor: OpenCodeSessionCursor
  ): Promise<BinderSessionRow[]> {
    // Why the cursor in the key: a round from before a stop can still be in flight
    // with an older cursor, and its rows are not the answer for a restarted round.
    const key = JSON.stringify([dbPath, cursor.ms, cursor.id])
    return this.openCodeBinderSessions.read(key, (id) => ({
      id,
      kind: 'openCodeBinderSessions',
      dbPath,
      cursor: { ms: cursor.ms, id: cursor.id }
    }))
  }

  dispose(): void {
    this.cursorProfile.dispose()
    this.openCodeBinderSessions.dispose()
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
