import type { WorkerThreadFactory } from '../lazy-worker-thread-host'
import { WorkerThreadRequestQueue } from '../worker-thread-request-queue'
import type { AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import type {
  OpenCodeSqliteCaptureValue,
  OpenCodeSqliteListValue,
  OpenCodeSqliteWorkerRequest,
  OpenCodeSqliteWorkerResponse
} from './session-scanner-opencode-sqlite-worker-protocol'
import { parseOpenCodeSqliteCaptureValue } from './session-scanner-opencode-sqlite-worker-response'
import type { SessionFileCandidate } from './session-scanner-types'
import { errorMessage } from './session-scanner-values'

// Why (#8864): a lazily-spawned, unref'd worker runs OpenCode SQLite reads off
// the main-process event loop. This module owns only the OpenCode legs; the
// request half (FIFO one-at-a-time dispatch, per-call timeouts, respawn-on-fault)
// is WorkerThreadRequestQueue and the thread's lifetime is LazyWorkerThreadHost,
// both shared with the port-scan probe and usage scan clients. The default spawn
// + shared singleton live in session-scanner-opencode-sqlite-worker-spawn.ts.

export const LIST_TIMEOUT_MS = 30_000
export const PARSE_TIMEOUT_MS = 15_000
// Longer than a parse because it reads every part of the session rather than
// the newest window, and shorter than nothing at all because the queue is FIFO.
export const CAPTURE_TIMEOUT_MS = 30_000
export const IDLE_TEARDOWN_MS = 30_000
// After this many consecutive worker deaths, fail the remaining queued calls to
// scan issues instead of respawning so a DB that reliably kills the worker can't
// spin a crash loop. Reset on any successful response, after draining, and when a
// fresh scan burst starts from idle (so the cap is per-scan, not process-wide).
export const MAX_CONSECUTIVE_DEATHS = 3

// Distinguishes "no worker available at all" from a timeout or crash so callers
// can surface a precise issue while keeping synchronous SQLite off the main thread.
class OpenCodeSqliteWorkerUnavailableError extends Error {}

// One session failed, not the whole source: the scanner turns this throw into a
// per-session scan issue and the search index records a failed read.
function sessionReadFailure(err: unknown): Error {
  if (err instanceof OpenCodeSqliteWorkerUnavailableError) {
    return new Error('OpenCode SQLite background scanner could not start.')
  }
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * Main-thread bridge that runs OpenCode SQLite reads on a persistent worker
 * thread. The shared request queue dispatches one request at a time (FIFO),
 * times each request out from dispatch, respawns after faults (capped by
 * `MAX_CONSECUTIVE_DEATHS`), tears the worker down after `IDLE_TEARDOWN_MS` of
 * inactivity, and fails closed when no worker can be spawned rather than moving
 * SQLite work onto the main thread.
 */
export class OpenCodeSqliteWorkerClient {
  private readonly requests: WorkerThreadRequestQueue<
    OpenCodeSqliteWorkerRequest,
    OpenCodeSqliteWorkerResponse
  >

  constructor(options: { workerFactory: WorkerThreadFactory; log?: (message: string) => void }) {
    const log = options.log ?? ((message: string) => console.warn(message))
    this.requests = new WorkerThreadRequestQueue({
      factory: options.workerFactory,
      idleTeardownMs: IDLE_TEARDOWN_MS,
      maxConsecutiveDeaths: MAX_CONSECUTIVE_DEATHS,
      createUnavailableError: (message) => new OpenCodeSqliteWorkerUnavailableError(message),
      describeTimeout: (timeoutMs) => `OpenCode SQLite worker timed out after ${timeoutMs}ms`,
      describeExit: (code) => `OpenCode SQLite worker exited with code ${code}`,
      describeCrashLoop: (lastError) =>
        `OpenCode SQLite worker crashed repeatedly; skipping remaining sessions (${lastError})`,
      // Why (#8864): never fall back to synchronous SQLite reads here; a missing
      // bundle or resource-exhausted spawn must omit OpenCode history rather than
      // reintroduce the main-process hang this worker boundary prevents.
      onUnavailable: (err) =>
        log(`OpenCode SQLite worker unavailable; skipping its history. ${errorMessage(err)}`)
    })
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
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the worker's list leg returns exactly this, built by the repo's own reader on the other side of a structured clone.
      const value = (await this.dispatch(
        (id) => ({ id, kind: 'list', dbPaths: args.dbPaths, limit: args.limit }),
        LIST_TIMEOUT_MS
      )) as OpenCodeSqliteListValue
      args.issues.push(...value.issues)
      return value.candidates
    } catch (err) {
      if (err instanceof OpenCodeSqliteWorkerUnavailableError) {
        // Kinded: a whole source failed, not a transcript.
        args.issues.push({
          agent: 'opencode',
          kind: 'scope',
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
        kind: 'scope',
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
        (id) => ({
          id,
          kind: 'parse',
          dbPath: args.dbPath,
          sessionId: args.sessionId,
          platform: args.platform
        }),
        PARSE_TIMEOUT_MS
      )
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the worker's parse leg returns exactly this, built by the repo's own reader on the other side of a structured clone.
      return value as AiVaultSession | null
    } catch (err) {
      throw sessionReadFailure(err)
    }
  }

  /**
   * Read one OpenCode session and its whole transcript on the worker.
   *
   * One request rather than a parse plus a second read: both halves then come
   * from a single open of the database, so the messages the index folds cannot
   * belong to a different generation of the session than the panel shows.
   * @param args.dbPath - Absolute path to the opencode.db file.
   * @param args.sessionId - Primary key in the `session` table.
   * @param args.platform - Platform used for resume-command generation.
   * @returns The session (null when it does not exist) and its messages;
   *   rejects on worker timeout/crash so the read is recorded as failed.
   */
  async capture(args: {
    dbPath: string
    sessionId: string
    platform: NodeJS.Platform
  }): Promise<OpenCodeSqliteCaptureValue> {
    try {
      const value = await this.dispatch(
        (id) => ({
          id,
          kind: 'capture',
          dbPath: args.dbPath,
          sessionId: args.sessionId,
          platform: args.platform
        }),
        CAPTURE_TIMEOUT_MS
      )
      return parseOpenCodeSqliteCaptureValue(value)
    } catch (err) {
      throw sessionReadFailure(err)
    }
  }

  private async dispatch(
    buildRequest: (id: number) => OpenCodeSqliteWorkerRequest,
    timeoutMs: number
  ): Promise<unknown> {
    const response = await this.requests.dispatch(buildRequest, timeoutMs)
    if (!response.ok) {
      throw new Error(response.error)
    }
    return response.value
  }
}
