import type { Worker } from 'node:worker_threads'
import type { AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import type {
  OpenCodeSqliteListRequest,
  OpenCodeSqliteListValue,
  OpenCodeSqliteParseRequest,
  OpenCodeSqliteWorkerRequest,
  OpenCodeSqliteWorkerResponse
} from './session-scanner-opencode-sqlite-worker-protocol'
import type { SessionFileCandidate } from './session-scanner-types'
import { errorMessage } from './session-scanner-values'

// Why (#8864): a lazily-spawned, unref'd worker runs OpenCode SQLite reads off
// the main-process event loop. Lifecycle (idle teardown, FIFO one-at-a-time
// dispatch, per-call timeouts, respawn-on-fault) mirrors src/main/speech/
// stt-service.ts. The default spawn + shared singleton live in
// session-scanner-opencode-sqlite-worker-spawn.ts.

export const LIST_TIMEOUT_MS = 30_000
export const PARSE_TIMEOUT_MS = 15_000
export const IDLE_TEARDOWN_MS = 30_000
// After this many consecutive worker deaths, fail the remaining queued calls to
// scan issues instead of respawning so a DB that reliably kills the worker can't
// spin a crash loop. Reset on any successful response, after draining, and when a
// fresh scan burst starts from idle (so the cap is per-scan, not process-wide).
export const MAX_CONSECUTIVE_DEATHS = 3

export type WorkerFactory = () => Worker

// Omit<union, 'id'> collapses to the shared keys, so omit each member and let
// the client stamp the correlation id.
type OpenCodeSqliteRequestBody =
  | Omit<OpenCodeSqliteListRequest, 'id'>
  | Omit<OpenCodeSqliteParseRequest, 'id'>

type PendingCall = {
  request: OpenCodeSqliteWorkerRequest
  timeoutMs: number
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | null
}

// Distinguishes "no worker available at all" from a timeout or crash so callers
// can surface a precise issue while keeping synchronous SQLite off the main thread.
class OpenCodeSqliteWorkerUnavailableError extends Error {}

/**
 * Main-thread bridge that runs OpenCode SQLite reads on a persistent worker
 * thread. Dispatches one request at a time (FIFO), times each request out from
 * dispatch, respawns after faults (capped by `MAX_CONSECUTIVE_DEATHS`), tears
 * the worker down after `IDLE_TEARDOWN_MS` of inactivity, and fails closed when
 * no worker can be spawned rather than moving SQLite work onto the main thread.
 */
export class OpenCodeSqliteWorkerClient {
  private worker: Worker | null = null
  private active: PendingCall | null = null
  private queue: PendingCall[] = []
  private idleTimer: NodeJS.Timeout | null = null
  private consecutiveDeaths = 0
  private nextId = 1
  private loggedWorkerUnavailable = false
  private cleanupWorkerListeners: (() => void) | null = null
  private readonly workerFactory: WorkerFactory
  private readonly log: (message: string) => void

  constructor(options: { workerFactory: WorkerFactory; log?: (message: string) => void }) {
    this.workerFactory = options.workerFactory
    this.log = options.log ?? ((message) => console.warn(message))
  }

  /**
   * List session candidates from the given OpenCode databases on the worker.
   * @param args.dbPaths - Absolute paths to opencode.db files to scan.
   * @param args.limit - Maximum number of sessions to return per database.
   * @param args.issues - Collected scan issues (worker issues are merged in).
   * @returns Synthetic candidates sorted by effective recency; empty (with a
   *   scan issue) when the worker is unavailable, times out, or crashes.
   */
  async list(args: {
    dbPaths: readonly string[]
    limit: number
    issues: AiVaultScanIssue[]
  }): Promise<SessionFileCandidate[]> {
    if (args.dbPaths.length === 0) {
      return []
    }
    try {
      const value = (await this.dispatch(
        { kind: 'list', dbPaths: args.dbPaths, limit: args.limit },
        LIST_TIMEOUT_MS
      )) as OpenCodeSqliteListValue
      args.issues.push(...value.issues)
      return value.candidates
    } catch (err) {
      if (err instanceof OpenCodeSqliteWorkerUnavailableError) {
        args.issues.push({
          agent: 'opencode',
          path: args.dbPaths[0] ?? 'opencode.db',
          message:
            'OpenCode history was skipped because its background scanner could not start; the app remains responsive.'
        })
        return []
      }
      // Timeout/crash: this storage dir's SQLite DBs contribute no sessions this
      // scan, surfaced as one scan issue rather than an unbounded stall.
      args.issues.push({
        agent: 'opencode',
        path: args.dbPaths[0] ?? 'opencode.db',
        message: `OpenCode history scan did not complete: ${errorMessage(err)}`
      })
      return []
    }
  }

  /**
   * Parse a single OpenCode session on the worker.
   * @param args.dbPath - Absolute path to the opencode.db file.
   * @param args.sessionId - Primary key in the `session` table.
   * @param args.platform - Platform used for resume-command generation.
   * @returns The parsed session, or `null` when it does not exist; rejects on
   *   worker timeout/crash so the scanner records a per-session scan issue.
   */
  async parse(args: {
    dbPath: string
    sessionId: string
    platform: NodeJS.Platform
  }): Promise<AiVaultSession | null> {
    try {
      const value = await this.dispatch(
        { kind: 'parse', dbPath: args.dbPath, sessionId: args.sessionId, platform: args.platform },
        PARSE_TIMEOUT_MS
      )
      return value as AiVaultSession | null
    } catch (err) {
      if (err instanceof OpenCodeSqliteWorkerUnavailableError) {
        throw new Error('OpenCode SQLite background scanner could not start.')
      }
      // Reject only this session; the scanner turns the throw into a scan issue.
      throw err instanceof Error ? err : new Error(String(err))
    }
  }

  private dispatch(request: OpenCodeSqliteRequestBody, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      // A fresh burst from full idle starts a new scan: clear any death count
      // carried from a prior scan so the respawn cap can't drain this scan early.
      if (!this.active && this.queue.length === 0) {
        this.consecutiveDeaths = 0
      }
      this.queue.push({
        request: { ...request, id } as OpenCodeSqliteWorkerRequest,
        timeoutMs,
        resolve,
        reject,
        timer: null
      })
      this.pump()
    })
  }

  private pump(): void {
    if (this.active || this.queue.length === 0) {
      return
    }
    const worker = this.ensureWorker()
    if (!worker) {
      this.failQueuedAsUnavailable()
      return
    }
    const call = this.queue.shift()
    if (!call) {
      return
    }
    this.active = call
    this.clearIdleTimer()
    // Timeout clock starts at dispatch (not enqueue): a batch may enqueue up to
    // 8 parses at once, and a queue-inclusive timeout would fire falsely.
    call.timer = setTimeout(() => this.onTimeout(call), call.timeoutMs)
    call.timer.unref?.()
    worker.postMessage(call.request)
  }

  private ensureWorker(): Worker | null {
    if (this.worker) {
      return this.worker
    }
    try {
      const worker = this.workerFactory()
      const onMessage = (response: OpenCodeSqliteWorkerResponse): void => this.onMessage(response)
      const onError = (error: Error): void => this.onWorkerFault(error)
      const onExit = (code: number): void => this.onWorkerExit(code)
      worker.on('message', onMessage)
      worker.on('error', onError)
      worker.on('exit', onExit)
      this.cleanupWorkerListeners = () => {
        worker.off('message', onMessage)
        worker.off('error', onError)
        worker.off('exit', onExit)
      }
      // Never keep the app alive for a scan worker.
      worker.unref?.()
      this.worker = worker
      return worker
    } catch (err) {
      // Why (#8864): never fall back to synchronous SQLite reads here; a missing
      // bundle or resource-exhausted spawn must omit OpenCode history rather than
      // reintroduce the main-process hang this worker boundary prevents.
      if (!this.loggedWorkerUnavailable) {
        this.loggedWorkerUnavailable = true
        this.log(`OpenCode SQLite worker unavailable; skipping its history. ${errorMessage(err)}`)
      }
      return null
    }
  }

  private onMessage(response: OpenCodeSqliteWorkerResponse): void {
    const call = this.active
    if (!call || call.request.id !== response.id) {
      return
    }
    this.consecutiveDeaths = 0
    if (response.ok) {
      this.settle(call, () => call.resolve(response.value))
    } else {
      this.settle(call, () => call.reject(new Error(response.error)))
    }
    this.afterSettle()
  }

  private onTimeout(call: PendingCall): void {
    if (this.active !== call) {
      return
    }
    this.onWorkerFault(new Error(`OpenCode SQLite worker timed out after ${call.timeoutMs}ms`))
  }

  private onWorkerExit(code: number): void {
    // A clean self-exit is not a death, but the stale handle must be dropped
    // or the next dispatch would post into the dead worker and stall to timeout.
    if (code === 0 && !this.active && this.queue.length === 0) {
      this.destroyWorker()
      return
    }
    this.onWorkerFault(new Error(`OpenCode SQLite worker exited with code ${code}`))
  }

  private onWorkerFault(error: Error): void {
    const failed = this.active
    this.destroyWorker()
    this.consecutiveDeaths++
    if (failed) {
      this.settle(failed, () => failed.reject(error))
    }
    if (this.consecutiveDeaths >= MAX_CONSECUTIVE_DEATHS) {
      this.drainQueueAfterCrashLoop(error)
      return
    }
    if (this.queue.length > 0) {
      this.pump()
    }
  }

  private drainQueueAfterCrashLoop(error: Error): void {
    const pending = this.queue
    this.queue = []
    this.consecutiveDeaths = 0
    const drainError = new Error(
      `OpenCode SQLite worker crashed repeatedly; skipping remaining sessions (${error.message})`
    )
    for (const call of pending) {
      this.settle(call, () => call.reject(drainError))
    }
  }

  private failQueuedAsUnavailable(): void {
    const pending = this.queue
    this.queue = []
    for (const call of pending) {
      this.settle(call, () =>
        call.reject(new OpenCodeSqliteWorkerUnavailableError('worker spawn failed'))
      )
    }
  }

  private settle(call: PendingCall, run: () => void): void {
    if (call.timer) {
      clearTimeout(call.timer)
      call.timer = null
    }
    if (this.active === call) {
      this.active = null
    }
    run()
  }

  private afterSettle(): void {
    if (this.queue.length > 0) {
      this.pump()
    } else {
      this.scheduleIdleTeardown()
    }
  }

  private scheduleIdleTeardown(): void {
    this.clearIdleTimer()
    if (!this.worker) {
      return
    }
    this.idleTimer = setTimeout(() => this.teardownIfIdle(), IDLE_TEARDOWN_MS)
    this.idleTimer.unref?.()
  }

  private teardownIfIdle(): void {
    this.idleTimer = null
    // Only tear down with nothing active AND nothing queued: a request arriving
    // as the timer fires must never be lost to a self-exiting worker.
    if (this.active || this.queue.length > 0) {
      return
    }
    this.destroyWorker()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private destroyWorker(): void {
    this.clearIdleTimer()
    const worker = this.worker
    this.worker = null
    if (!worker) {
      return
    }
    this.cleanupWorkerListeners?.()
    this.cleanupWorkerListeners = null
    worker.removeAllListeners()
    void worker.terminate().catch(() => undefined)
  }
}
