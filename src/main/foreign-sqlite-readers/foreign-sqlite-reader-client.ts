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

// Foreign SQLite opens can block on WAL rebuilds; isolate each reader so slow databases cannot stall main or peers.

const READ_TIMEOUT_MS: Record<ForeignSqliteReaderKind, number> = {
  // Allow margin beyond observed 4–6s WAL-index rebuilds.
  cursorProfile: 10_000,
  openCodeBinderSessions: 60_000
}
// Keep workers alive across poll intervals to avoid spawning on every round.
const DEFAULT_IDLE_TEARDOWN_MS: Record<ForeignSqliteReaderKind, number> = {
  cursorProfile: 30_000,
  // The binder polls once per minute.
  openCodeBinderSessions: 120_000
}
const MAX_CONSECUTIVE_DEATHS = 2
const MAX_QUEUED_READS = 8

type LaneSettings = {
  workerFactory: WorkerThreadFactory
  log: (message: string) => void
  timeoutMs: number
  idleTeardownMs: number
}

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

  /** Concurrent reads share a key, so it must encode every input that can change the result. */
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
      // A failed worker read must never fall back to blocking the main thread.
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

  readCursorProfile(dbPath: string): Promise<CursorDesktopProfileReadResult> {
    return this.cursorProfile.read(dbPath, (id) => ({ id, kind: 'cursorProfile', dbPath }))
  }

  /** Return oldest-first sessions after cursor, or [] if the worker cannot answer. */
  readOpenCodeBinderSessions(
    dbPath: string,
    cursor: OpenCodeSessionCursor
  ): Promise<BinderSessionRow[]> {
    // A restarted poll must not deduplicate against an older cursor still in flight.
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
