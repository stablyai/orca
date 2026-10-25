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

// Codex's SQLite backfill is one-shot; thread/read indexes rollouts hardlinked in later.

// Bounded sessions and concurrency limit memory, stalled work and background I/O.
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
        summary.missingThreads += 1
      } else {
        summary.failedThreads += 1
      }
      recordHealOutcome(paths, thread, readOutcome)
    },
    options
  )
  if (outcome === 'unsupported') {
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

/** Transport failures and SQLite contention leave affected reads unreported for retry. */
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
      // Transport errors leave this read unreported for retry.
      throw error
    }
    if (/no rollout found/i.test(message)) {
      return 'missing'
    }
    if (isTransientSqliteContention(message)) {
      // SQLite contention is temporary; leave this read unreported for retry.
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
    // Disable plugins so batch teardown cannot leave marketplace clones running.
    args: [...CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS],
    cliPath: command,
    // Override inherited managed homes to avoid indexing the wrong database.
    env: { CODEX_HOME: codexHomePath },
    timeoutMs
  }
}
