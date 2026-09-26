import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { isTransientSqliteContention } from '../sqlite/sqlite-read-failure'
import {
  isCodexAppServerUnsupportedError,
  runCodexAppServerSession,
  type CodexAppServerInvocation,
  type CodexAppServerRpc
} from './codex-app-server-session'
import {
  buildNativeHealInvocation,
  HEAL_BATCH_TIMEOUT_BASE_MS,
  HEAL_BATCH_TIMEOUT_PER_READ_MS,
  HEAL_INTER_BATCH_DELAY_MS,
  HEAL_READ_CONCURRENCY,
  HEAL_READS_PER_SERVER_SESSION
} from './codex-session-index-heal'
import { readIndexedCodexThreadIds } from './codex-state-db'

// Why: Codex indexes a home's rollouts only once, when it first creates the
// state DB, and the /resume picker's "All" view lists only indexed threads.
// History bridged in afterwards needs `thread/read`, Codex's lazy-indexing
// path, to become visible there (#20669). Same mechanism as the system-home
// heal in codex-session-index-heal.ts, scoped to one account home.

export type CodexAccountSessionIndexHealSummary = {
  outcome: 'completed' | 'up-to-date' | 'unreadable' | 'unsupported' | 'aborted'
  healedThreads: number
  failedThreads: number
}

export type CodexAccountSessionIndexHealDependencies = {
  readIndexedThreadIds: (codexHomePath: string) => Set<string> | null
  buildInvocation: (codexHomePath: string, timeoutMs: number) => CodexAppServerInvocation
  runSession: (
    invocation: CodexAppServerInvocation,
    body: (rpc: CodexAppServerRpc) => Promise<void>
  ) => Promise<void>
  interBatchDelayMs: number
}

const defaultDependencies: CodexAccountSessionIndexHealDependencies = {
  readIndexedThreadIds: readIndexedCodexThreadIds,
  buildInvocation: buildNativeHealInvocation,
  runSession: runCodexAppServerSession,
  interBatchDelayMs: HEAL_INTER_BATCH_DELAY_MS
}

// Why: a rollout Codex refuses to index would otherwise respawn app-server on
// every launch; retry it only after Orca restarts.
const failedThreadIdsByHome = new Map<string, Set<string>>()

/**
 * Starts Codex once on an empty home so it creates and indexes its state DB
 * before any history is bridged in. False when Codex could not start.
 */
export async function createCodexAccountStateDb(
  codexHomePath: string,
  dependenciesOverride: Partial<CodexAccountSessionIndexHealDependencies> = {}
): Promise<boolean> {
  const dependencies = { ...defaultDependencies, ...dependenciesOverride }
  try {
    // Why: app-server finishes state DB startup before it answers `initialize`.
    await dependencies.runSession(
      dependencies.buildInvocation(codexHomePath, HEAL_BATCH_TIMEOUT_BASE_MS),
      async () => {}
    )
    return true
  } catch (error) {
    // Why: a Codex without app-server predates the state DB, so linking cannot stall it.
    if (isCodexAppServerUnsupportedError(error)) {
      return true
    }
    console.warn('[codex-account-session-index-heal] Failed to create Codex state DB:', error)
    return false
  }
}

/**
 * Indexes the bridged threads Codex has not indexed yet. Diffing against the
 * state DB on every pass makes an interrupted heal resume on the next launch.
 */
export async function healCodexAccountSessionIndex(
  codexHomePath: string,
  bridgedThreadIds: ReadonlySet<string>,
  dependenciesOverride: Partial<CodexAccountSessionIndexHealDependencies> = {}
): Promise<CodexAccountSessionIndexHealSummary> {
  const dependencies = { ...defaultDependencies, ...dependenciesOverride }
  const summary: CodexAccountSessionIndexHealSummary = {
    outcome: 'completed',
    healedThreads: 0,
    failedThreads: 0
  }
  if (bridgedThreadIds.size === 0) {
    return { ...summary, outcome: 'up-to-date' }
  }
  const indexed = dependencies.readIndexedThreadIds(codexHomePath)
  if (!indexed) {
    return { ...summary, outcome: 'unreadable' }
  }
  const homeKey = normalizeRuntimePathForComparison(codexHomePath)
  const failed = failedThreadIdsByHome.get(homeKey) ?? new Set<string>()
  failedThreadIdsByHome.set(homeKey, failed)
  const pending = [...bridgedThreadIds].filter((id) => !indexed.has(id) && !failed.has(id))
  if (pending.length === 0) {
    return { ...summary, outcome: 'up-to-date' }
  }

  for (let offset = 0; offset < pending.length; offset += HEAL_READS_PER_SERVER_SESSION) {
    if (offset > 0 && dependencies.interBatchDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, dependencies.interBatchDelayMs))
    }
    const batch = pending.slice(offset, offset + HEAL_READS_PER_SERVER_SESSION)
    const timeoutMs = HEAL_BATCH_TIMEOUT_BASE_MS + HEAL_BATCH_TIMEOUT_PER_READ_MS * batch.length
    try {
      await dependencies.runSession(
        dependencies.buildInvocation(codexHomePath, timeoutMs),
        async (rpc) => {
          let nextIndex = 0
          const worker = async (): Promise<void> => {
            while (nextIndex < batch.length) {
              const threadId = batch[nextIndex]
              nextIndex += 1
              await healOneThread(rpc, threadId, failed, summary)
            }
          }
          await Promise.all(Array.from({ length: HEAL_READ_CONCURRENCY }, () => worker()))
        }
      )
    } catch (error) {
      if (isCodexAppServerUnsupportedError(error)) {
        return { ...summary, outcome: 'unsupported' }
      }
      // Why: unread ids stay out of the state DB, so the next launch's diff retries them.
      console.warn('[codex-account-session-index-heal] Heal batch aborted:', error)
      return { ...summary, outcome: 'aborted' }
    }
  }
  return summary
}

async function healOneThread(
  rpc: CodexAppServerRpc,
  threadId: string,
  failed: Set<string>,
  summary: CodexAccountSessionIndexHealSummary
): Promise<void> {
  try {
    await rpc.request('thread/read', { threadId })
    summary.healedThreads += 1
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Why: transport failures and sqlite contention (a live Codex TUI owns the
    // DB) abort the batch so the id is retried, not written off.
    if (
      isCodexAppServerUnsupportedError(error) ||
      !message.startsWith('codex app-server thread/read failed') ||
      isTransientSqliteContention(message)
    ) {
      throw error
    }
    failed.add(threadId)
    summary.failedThreads += 1
  }
}

export const _internals = {
  resetFailedThreads: (): void => {
    failedThreadIdsByHome.clear()
  }
}
