import { dirname, join } from 'node:path'
import { resolveCodexCommand } from '../codex-cli/command'
import { isTransientSqliteContention } from '../sqlite/sqlite-read-failure'
import { CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'
import { getCodexSessionBackfillStateDirPath } from './codex-home-paths'
import { resolveCodexSessionBackfillPaths } from './codex-session-backfill'
import {
  appendHealLedgerRecord,
  collectPendingHealThreads,
  isHealMarkerCurrent,
  readAuditLogSize,
  writeHealMarker,
  type CodexSessionIndexHealPaths,
  type HealLedgerOutcome,
  type PendingHealThread
} from './codex-session-index-heal-state'
import {
  isCodexAppServerUnsupportedError,
  runCodexAppServerSession,
  type CodexAppServerInvocation,
  type CodexAppServerRpc
} from './codex-app-server-session'

export type { CodexSessionIndexHealPaths } from './codex-session-index-heal-state'

// Why: Codex's own sqlite metadata backfill is one-shot (backfill_state is
// stamped `complete` on first app-server startup), so rollouts that Orca's
// session backfill hardlinks in later never reach the state DB on their own.
// `thread/read` is Codex's sanctioned lazy-indexing path: it parses the
// rollout and upserts the thread row, making backfilled sessions visible to
// Codex's DB-driven surfaces. Orca never writes Codex's sqlite schema itself.

// Why: one server session per batch bounds child memory and keeps a wedged
// server from stalling the whole pass; small in-session concurrency keeps the
// disk/CPU cost background-grade instead of a thundering read storm.
const HEAL_READS_PER_SERVER_SESSION = 50
const HEAL_READ_CONCURRENCY = 2
const HEAL_INTER_BATCH_DELAY_MS = 500
const HEAL_BATCH_TIMEOUT_BASE_MS = 15_000
const HEAL_BATCH_TIMEOUT_PER_READ_MS = 2_000

export type CodexSessionIndexHealSummary = {
  outcome: 'completed' | 'stopped' | 'unsupported' | 'aborted' | 'up-to-date'
  pendingThreads: number
  healedThreads: number
  missingThreads: number
  failedThreads: number
}

export type CodexSessionIndexHealOptions = {
  /** Polled between reads and batches; true stops promptly, progress is kept. */
  shouldStop?: () => boolean
  buildInvocation?: (codexHomePath: string, timeoutMs: number) => CodexAppServerInvocation
  runSession?: (
    invocation: CodexAppServerInvocation,
    body: (rpc: CodexAppServerRpc) => Promise<void>
  ) => Promise<void>
  readsPerServerSession?: number
  readConcurrency?: number
  interBatchDelayMs?: number
}

export type CodexThreadReadOutcome = HealLedgerOutcome

export type CodexThreadReadPassOutcome = 'completed' | 'stopped' | 'unsupported' | 'aborted'

let backgroundHealTask: Promise<CodexSessionIndexHealSummary | null> | null = null

export function resolveCodexSessionIndexHealPaths(
  systemCodexHomePathOverride?: string
): CodexSessionIndexHealPaths {
  const backfillPaths = resolveCodexSessionBackfillPaths(systemCodexHomePathOverride)
  const stateDir = getCodexSessionBackfillStateDirPath()
  return {
    auditLogPath: backfillPaths.auditLogPath,
    systemSessionsRoot: backfillPaths.systemSessionsRoot,
    healLedgerPath: join(stateDir, 'index-heal-ledger.jsonl'),
    healMarkerPath: join(stateDir, 'index-heal-complete.json')
  }
}

/**
 * Starts a single background index-heal pass for backfilled Codex sessions.
 *
 * Concurrent callers share the in-flight task; an up-to-date marker resolves
 * without reading the audit ledger or spawning any app-server.
 */
export function startCodexSessionIndexHealInBackground(
  options: CodexSessionIndexHealOptions = {},
  systemCodexHomePathOverride?: string
): Promise<CodexSessionIndexHealSummary | null> {
  if (backgroundHealTask) {
    return backgroundHealTask
  }
  const task = runCodexSessionIndexHeal(
    resolveCodexSessionIndexHealPaths(systemCodexHomePathOverride),
    options
  ).catch((error: unknown) => {
    console.warn('[codex-session-index-heal] Background index heal failed:', error)
    return null
  })
  backgroundHealTask = task
  void task.finally(() => {
    if (backgroundHealTask === task) {
      backgroundHealTask = null
    }
  })
  return task
}

/**
 * Drives Codex's lazy thread indexing (`thread/read`) for every backfilled
 * session recorded in the backfill audit ledger that this pass has not
 * processed yet, most recent sessions first.
 */
export async function runCodexSessionIndexHeal(
  paths: CodexSessionIndexHealPaths,
  options: CodexSessionIndexHealOptions = {}
): Promise<CodexSessionIndexHealSummary> {
  const auditBytes = readAuditLogSize(paths.auditLogPath)
  if (isHealMarkerCurrent(paths, auditBytes)) {
    return {
      outcome: 'up-to-date',
      pendingThreads: 0,
      healedThreads: 0,
      missingThreads: 0,
      failedThreads: 0
    }
  }

  const pending = await collectPendingHealThreads(paths)
  const summary: CodexSessionIndexHealSummary = {
    outcome: 'completed',
    pendingThreads: pending.length,
    healedThreads: 0,
    missingThreads: 0,
    failedThreads: 0
  }
  if (pending.length === 0) {
    writeHealMarker(paths, auditBytes, summary)
    return summary
  }

  const shouldStop = options.shouldStop ?? ((): boolean => false)
  const outcome = await readCodexThreadsForIndexHeal(
    dirname(paths.systemSessionsRoot),
    pending,
    (thread, readOutcome) => {
      if (readOutcome === 'healed') {
        summary.healedThreads += 1
      } else if (readOutcome === 'missing') {
        // The backfilled rollout was deleted after the audit was written.
        summary.missingThreads += 1
      } else {
        summary.failedThreads += 1
      }
      recordHealOutcome(paths, thread, readOutcome)
    },
    options
  )
  if (outcome === 'unsupported') {
    // Why: no retry churn on old CLIs — remember unsupported and re-probe
    // after the retry interval or a version bump; nothing is marked healed.
    writeHealMarker(paths, auditBytes, summary, { unsupportedAt: Date.now() })
  }
  if (outcome !== 'completed' || shouldStop()) {
    summary.outcome = outcome === 'completed' ? 'stopped' : outcome
    return summary
  }
  writeHealMarker(
    paths,
    auditBytes,
    summary,
    summary.failedThreads > 0 ? { retryableFailureAt: Date.now() } : undefined
  )
  return summary
}

/**
 * Drives `thread/read` over `threads` in bounded app-server batches, reporting
 * each settled read. Transport failures and sqlite contention abort the pass
 * without reporting, so the caller's next pass retries those threads.
 */
export async function readCodexThreadsForIndexHeal<T extends { threadId: string }>(
  codexHomePath: string,
  threads: readonly T[],
  onOutcome: (thread: T, outcome: CodexThreadReadOutcome) => void,
  options: CodexSessionIndexHealOptions = {}
): Promise<CodexThreadReadPassOutcome> {
  const buildInvocation = options.buildInvocation ?? buildNativeHealInvocation
  const runSession = options.runSession ?? runCodexAppServerSession
  const readsPerServerSession = resolveHealWorkLimit(
    options.readsPerServerSession,
    HEAL_READS_PER_SERVER_SESSION
  )
  const readConcurrency = resolveHealWorkLimit(options.readConcurrency, HEAL_READ_CONCURRENCY)
  const interBatchDelayMs = options.interBatchDelayMs ?? HEAL_INTER_BATCH_DELAY_MS
  const shouldStop = options.shouldStop ?? ((): boolean => false)

  for (let offset = 0; offset < threads.length; offset += readsPerServerSession) {
    if (shouldStop()) {
      return 'stopped'
    }
    if (offset > 0 && interBatchDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, interBatchDelayMs))
      if (shouldStop()) {
        // Why: opt-out can happen during the throttle delay; do not spawn an
        // app-server after the lane has been disabled.
        return 'stopped'
      }
    }
    const batch = threads.slice(offset, offset + readsPerServerSession)
    const timeoutMs = HEAL_BATCH_TIMEOUT_BASE_MS + HEAL_BATCH_TIMEOUT_PER_READ_MS * batch.length
    try {
      await runSession(buildInvocation(codexHomePath, timeoutMs), async (rpc) => {
        let nextIndex = 0
        const worker = async (): Promise<void> => {
          while (nextIndex < batch.length && !shouldStop()) {
            const thread = batch[nextIndex]
            nextIndex += 1
            onOutcome(thread, await readOneThread(rpc, thread.threadId))
          }
        }
        await Promise.all(Array.from({ length: readConcurrency }, () => worker()))
      })
    } catch (error) {
      if (shouldStop()) {
        return 'stopped'
      }
      if (isCodexAppServerUnsupportedError(error)) {
        return 'unsupported'
      }
      // Transport failure (timeout, early exit, spawn error): unprocessed ids
      // were never reported, so the next pass resumes them.
      console.warn('[codex-session-index-heal] Heal batch aborted:', error)
      return 'aborted'
    }
  }
  return 'completed'
}

async function readOneThread(
  rpc: CodexAppServerRpc,
  threadId: string
): Promise<CodexThreadReadOutcome> {
  try {
    await rpc.request('thread/read', { threadId })
    return 'healed'
  } catch (error) {
    if (isCodexAppServerUnsupportedError(error)) {
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    if (!message.startsWith('codex app-server thread/read failed')) {
      // Not an RPC-level response: the server died or timed out. Abort the
      // batch without reporting, so the id is retried on the next pass.
      throw error
    }
    if (/no rollout found/i.test(message)) {
      return 'missing'
    }
    if (isTransientSqliteContention(message)) {
      // Why: an active Codex process can briefly own sqlite; leave the id
      // unreported and abort this pass so a later startup resumes it.
      throw error
    }
    return 'failed'
  }
}

function recordHealOutcome(
  paths: CodexSessionIndexHealPaths,
  thread: PendingHealThread,
  outcome: HealLedgerOutcome
): void {
  if (!appendHealLedgerRecord(paths, thread.threadId, outcome, thread.auditRecordId)) {
    throw new Error(`Failed to persist Codex session index-heal outcome for ${thread.threadId}`)
  }
}

function resolveHealWorkLimit(value: number | undefined, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return maximum
  }
  return Math.min(Math.floor(value), maximum)
}

export function buildNativeHealInvocation(
  codexHomePath: string,
  timeoutMs: number
): CodexAppServerInvocation {
  const command = resolveCodexCommand()
  return {
    command,
    // Why: each session is torn down after one batch, so plugin startup could
    // leave marketplace clones running; indexing needs neither plugins nor tools.
    args: [...CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS],
    cliPath: command,
    // Why: pin the home explicitly — nested Orca launches can inherit a managed
    // CODEX_HOME from the daemon environment, which would index the wrong sqlite DB.
    env: { CODEX_HOME: codexHomePath },
    timeoutMs
  }
}
