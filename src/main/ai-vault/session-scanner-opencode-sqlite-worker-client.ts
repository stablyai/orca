import type { WorkerThreadFactory } from '../lazy-worker-thread-host'
import { aiVaultScanIssueText } from '../../shared/ai-vault-scan-issue-copy'
import { WorkerThreadRequestQueue } from '../worker-thread-request-queue'
import type { AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import type {
  OpenCodeNativeChatReadRequest,
  OpenCodeNativeChatReadValue,
  OpenCodeSqliteCaptureValue,
  OpenCodeSqliteListValue,
  OpenCodeSqliteWorkerRequest,
  OpenCodeSqliteWorkerResponse
} from './session-scanner-opencode-sqlite-worker-protocol'
import { parseOpenCodeSqliteCaptureValue } from './session-scanner-opencode-sqlite-worker-response'
import type { SessionFileCandidate } from './session-scanner-types'
import { errorMessage } from './session-scanner-values'
import { runOpenCodeSqliteScanRequest } from './session-scanner-opencode-sqlite-scan-scope'

// Adapt OpenCode reads to the shared worker queue and lazy host; spawning is wired in worker-spawn.

export const LIST_TIMEOUT_MS = 30_000
export const PARSE_TIMEOUT_MS = 15_000
// Full captures need more time than previews but must not block the FIFO queue indefinitely.
export const CAPTURE_TIMEOUT_MS = 30_000
export const IDLE_TEARDOWN_MS = 30_000
// Bound crash loops per active burst; successful responses or a fresh idle burst reset the death count.
export const MAX_CONSECUTIVE_DEATHS = 3

class OpenCodeSqliteWorkerUnavailableError extends Error {}

// Reject failed session reads so scans report them and search indexing can retry.
function sessionReadFailure(err: unknown): Error {
  if (err instanceof OpenCodeSqliteWorkerUnavailableError) {
    return new Error('OpenCode SQLite background scanner could not start.')
  }
  return err instanceof Error ? err : new Error(String(err))
}

/** Serialize timed worker reads and fail closed; never run synchronous SQLite on the main thread. */
export class OpenCodeSqliteWorkerClient {
  private readonly requestTimeoutMs: number | undefined
  private readonly requests: WorkerThreadRequestQueue<
    OpenCodeSqliteWorkerRequest,
    OpenCodeSqliteWorkerResponse
  >

  constructor(options: {
    workerFactory: WorkerThreadFactory
    log?: (message: string) => void
    idleTeardownMs?: number
    requestTimeoutMs?: number
  }) {
    this.requestTimeoutMs = options.requestTimeoutMs
    const log = options.log ?? ((message: string) => console.warn(message))
    this.requests = new WorkerThreadRequestQueue({
      factory: options.workerFactory,
      idleTeardownMs: options.idleTeardownMs ?? IDLE_TEARDOWN_MS,
      queueCap: { maxQueuedCalls: 64, describeFull: () => 'OpenCode SQLite reader queue is full.' },
      maxConsecutiveDeaths: MAX_CONSECUTIVE_DEATHS,
      createUnavailableError: (message) => new OpenCodeSqliteWorkerUnavailableError(message),
      describeTimeout: (timeoutMs) => `OpenCode SQLite worker timed out after ${timeoutMs}ms`,
      describeExit: (code) => `OpenCode SQLite worker exited with code ${code}`,
      describeCrashLoop: (lastError) =>
        `OpenCode SQLite worker crashed repeatedly; skipping remaining sessions (${lastError})`,
      // Missing bundles or failed spawns must not reintroduce main-thread SQLite hangs (#8864).
      onUnavailable: (err) =>
        log(`OpenCode SQLite worker unavailable; skipping its history. ${errorMessage(err)}`)
    })
  }

  /** Return no candidates and a scope issue when the background worker fails. */
  async list(args: {
    dbPaths: readonly string[]
    limit: number
    issues: AiVaultScanIssue[]
    agent?: 'opencode2' | 'zcode'
    scopePaths?: readonly string[]
    signal?: AbortSignal
  }): Promise<SessionFileCandidate[]> {
    if (args.dbPaths.length === 0) {
      return []
    }
    try {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the worker's list leg returns exactly this, built by the repo's own reader on the other side of a structured clone.
      const value = (await this.dispatch(
        (id) => ({
          id,
          kind: 'list',
          dbPaths: args.dbPaths,
          limit: Number.isFinite(args.limit) ? args.limit : null,
          ...(args.agent ? { agent: args.agent } : {}),
          ...(args.scopePaths?.length ? { scopePaths: args.scopePaths } : {})
        }),
        LIST_TIMEOUT_MS,
        args.signal,
        args.agent
      )) as OpenCodeSqliteListValue
      args.issues.push(...value.issues)
      return value.candidates
    } catch (err) {
      if (args.signal?.aborted) {
        throw err
      }
      if (err instanceof OpenCodeSqliteWorkerUnavailableError) {
        args.issues.push({
          agent: args.agent ?? 'opencode',
          kind: 'scope',
          path: args.dbPaths[0] ?? 'opencode.db',
          ...aiVaultScanIssueText('openCodeScannerUnavailable')
        })
        return []
      }
      args.issues.push({
        agent: args.agent ?? 'opencode',
        kind: 'scope',
        path: args.dbPaths[0] ?? 'opencode.db',
        ...aiVaultScanIssueText('openCodeScanIncomplete', {
          detail: errorMessage(err)
        })
      })
      return []
    }
  }

  /** Missing sessions return null; worker failures reject for per-session scan reporting. */
  async parse(args: {
    fullFirstUserPrompt?: boolean
    dbPath: string
    sessionId: string
    platform: NodeJS.Platform
    agent?: 'opencode2' | 'zcode'
    signal?: AbortSignal
  }): Promise<AiVaultSession | null> {
    try {
      const value = await this.dispatch(
        (id) => ({
          id,
          kind: 'parse',
          ...(args.fullFirstUserPrompt ? { fullFirstUserPrompt: true } : {}),
          dbPath: args.dbPath,
          sessionId: args.sessionId,
          platform: args.platform,
          ...(args.agent ? { agent: args.agent } : {})
        }),
        PARSE_TIMEOUT_MS,
        args.signal,
        args.agent
      )
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the worker's parse leg returns exactly this, built by the repo's own reader on the other side of a structured clone.
      return value as AiVaultSession | null
    } catch (err) {
      throw sessionReadFailure(err)
    }
  }

  /** Request metadata and the full transcript together; reject worker failures so indexing can retry. */
  async capture(args: {
    dbPath: string
    sessionId: string
    platform: NodeJS.Platform
    agent?: 'opencode2' | 'zcode'
    signal?: AbortSignal
  }): Promise<OpenCodeSqliteCaptureValue> {
    try {
      const value = await this.dispatch(
        (id) => ({
          id,
          kind: 'capture',
          dbPath: args.dbPath,
          sessionId: args.sessionId,
          platform: args.platform,
          ...(args.agent ? { agent: args.agent } : {})
        }),
        CAPTURE_TIMEOUT_MS,
        args.signal,
        args.agent
      )
      return parseOpenCodeSqliteCaptureValue(value)
    } catch (err) {
      throw sessionReadFailure(err)
    }
  }

  async readNativeChat(
    args: Omit<OpenCodeNativeChatReadRequest, 'id'>,
    signal?: AbortSignal
  ): Promise<OpenCodeNativeChatReadValue> {
    const value = await this.dispatch(
      (id) => ({ ...args, id }),
      PARSE_TIMEOUT_MS,
      signal,
      'native-chat'
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only this build's internal worker dispatch constructs page/signal results; they are not client-supplied paths or frames.
    return value as OpenCodeNativeChatReadValue
  }

  dispose(): void {
    this.requests.dispose()
  }

  private async dispatch(
    buildRequest: (id: number) => OpenCodeSqliteWorkerRequest,
    timeoutMs: number,
    signal?: AbortSignal,
    agent?: 'opencode2' | 'zcode' | 'native-chat'
  ): Promise<unknown> {
    const deadline = this.requestTimeoutMs ?? timeoutMs
    const response = await runOpenCodeSqliteScanRequest(
      signal,
      (requestSignal, owner) =>
        this.requests.dispatch(
          (id) => ({ ...buildRequest(id), timeoutMs: deadline }),
          deadline,
          requestSignal,
          owner
        ),
      agent
    )
    if (!response.ok) {
      throw new Error(response.error)
    }
    return response.value
  }
}
