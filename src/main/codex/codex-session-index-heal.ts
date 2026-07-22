import { dirname, join } from 'node:path'
import { resolveCodexCommand } from '../codex-cli/command'
import { getSpawnArgsForWindows } from '../win32-utils'
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
  type CodexAppServerInvocation
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
  buildInvocation?: (systemCodexHomePath: string, timeoutMs: number) => CodexAppServerInvocation
  readsPerServerSession?: number
  readConcurrency?: number
  interBatchDelayMs?: number
}

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

  const pending = collectPendingHealThreads(paths)
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

  const systemCodexHomePath = dirname(paths.systemSessionsRoot)
  const buildInvocation = options.buildInvocation ?? buildNativeHealInvocation
  const readsPerServerSession = resolveHealWorkLimit(
    options.readsPerServerSession,
    HEAL_READS_PER_SERVER_SESSION
  )
  const readConcurrency = resolveHealWorkLimit(options.readConcurrency, HEAL_READ_CONCURRENCY)
  const interBatchDelayMs = options.interBatchDelayMs ?? HEAL_INTER_BATCH_DELAY_MS
  const shouldStop = options.shouldStop ?? ((): boolean => false)

  for (let offset = 0; offset < pending.length; offset += readsPerServerSession) {
    if (shouldStop()) {
      summary.outcome = 'stopped'
      return summary
    }
    if (offset > 0 && interBatchDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, interBatchDelayMs))
      if (shouldStop()) {
        // Why: opt-out can happen during the throttle delay; do not spawn a
        // real-home app-server after the lane has been disabled.
        summary.outcome = 'stopped'
        return summary
      }
    }
    const batch = pending.slice(offset, offset + readsPerServerSession)
    const timeoutMs = HEAL_BATCH_TIMEOUT_BASE_MS + HEAL_BATCH_TIMEOUT_PER_READ_MS * batch.length
    try {
      await runCodexAppServerSession(
        buildInvocation(systemCodexHomePath, timeoutMs),
        async (rpc) => {
          let nextIndex = 0
          const worker = async (): Promise<void> => {
            while (nextIndex < batch.length && !shouldStop()) {
              const thread = batch[nextIndex]
              nextIndex += 1
              await healOneThread(rpc, thread, paths, summary)
            }
          }
          await Promise.all(Array.from({ length: readConcurrency }, () => worker()))
        }
      )
    } catch (error) {
      if (isCodexAppServerUnsupportedError(error)) {
        if (shouldStop()) {
          summary.outcome = 'stopped'
          return summary
        }
        // Why: no retry churn on old CLIs — remember unsupported and re-probe
        // after the retry interval or a version bump; nothing is marked healed.
        writeHealMarker(paths, auditBytes, summary, { unsupportedAt: Date.now() })
        summary.outcome = 'unsupported'
        return summary
      }
      // Transport failure (timeout, early exit, spawn error): unprocessed ids
      // were never appended to the ledger, so the next pass resumes them.
      console.warn('[codex-session-index-heal] Heal batch aborted:', error)
      summary.outcome = 'aborted'
      return summary
    }
  }

  if (shouldStop()) {
    summary.outcome = 'stopped'
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

async function healOneThread(
  rpc: { request: (method: string, params?: Record<string, unknown>) => Promise<unknown> },
  thread: PendingHealThread,
  paths: CodexSessionIndexHealPaths,
  summary: CodexSessionIndexHealSummary
): Promise<void> {
  try {
    await rpc.request('thread/read', { threadId: thread.threadId })
    summary.healedThreads += 1
    recordHealOutcome(paths, thread, 'healed')
  } catch (error) {
    if (isCodexAppServerUnsupportedError(error)) {
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    if (!message.startsWith('codex app-server thread/read failed')) {
      // Not an RPC-level response: the server died or timed out. Abort the
      // batch without recording, so the id is retried on the next pass.
      throw error
    }
    if (/no rollout found/i.test(message)) {
      // The backfilled rollout was deleted after the audit was written.
      summary.missingThreads += 1
      recordHealOutcome(paths, thread, 'missing')
      return
    }
    if (/SQLITE_(?:BUSY|LOCKED)|database (?:is )?(?:busy|locked)/i.test(message)) {
      // Why: an active Codex process can briefly own sqlite; leave the id off
      // the ledger and abort this pass so a later startup resumes it.
      throw error
    }
    summary.failedThreads += 1
    recordHealOutcome(paths, thread, 'failed')
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

function buildNativeHealInvocation(
  systemCodexHomePath: string,
  timeoutMs: number
): CodexAppServerInvocation {
  const command = resolveCodexCommand()
  const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(command, ['app-server'])
  return {
    command: spawnCmd,
    args: spawnArgs,
    // Why: pin the real home explicitly — nested Orca launches can inherit a
    // managed CODEX_HOME from the daemon environment, which would index the
    // wrong sqlite DB.
    env: { CODEX_HOME: systemCodexHomePath },
    timeoutMs
  }
}
