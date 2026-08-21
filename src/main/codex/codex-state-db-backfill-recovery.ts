import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { withManagedHookInstallLock } from '../agent-hooks/managed-hook-install-lock'
import { readManagedHookHostIdentity } from '../agent-hooks/managed-hook-owner-identity'
import { buildWslCodexAppServerArgs } from '../codex-accounts/wsl-codex-command'
import { resolveCodexCommand } from '../codex-cli/command'
import { CODEX_READ_ONLY_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'
import { terminateCodexProbeChild } from '../rate-limits/codex-probe-termination'
import { getSpawnArgsForWindows } from '../win32-utils'
import { getOrcaUserDataPath } from './codex-home-paths'
import {
  BACKFILL_PENDING_MIN_SESSION_FILES,
  countCodexSessionFilesUpTo,
  isCodexStateDbBackfillPending,
  readCodexStateDbBackfillStatus,
  type CodexStateDbBackfillStatus
} from './codex-state-db'

const RECOVERY_POLL_INTERVAL_MS = 5_000
const RECOVERY_RETRY_DELAY_MS = 2_000
const RECOVERY_MAX_COORDINATOR_FAILURES = 5
const RECOVERY_MAX_SPAWNS = 5
const RECOVERY_MAX_TOTAL_MS = 60 * 60_000
const RECOVERY_OWNER_CHECK_TIMEOUT_MS = 1_000

export type CodexStateDbBackfillRecoverySummary = {
  outcome: 'completed' | 'already-complete' | 'not-needed' | 'unreadable' | 'stopped' | 'gave-up'
  spawnCount: number
}

type RecoveryDependencies = {
  spawnProcess: typeof spawn
  resolveCommand: () => string
  readStatus: (codexHomePath: string) => CodexStateDbBackfillStatus
  countSessions: (sessionsRoot: string, limit: number) => number
  now: () => number
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  terminate: (child: ChildProcess) => Promise<void>
}

const defaultDependencies: RecoveryDependencies = {
  spawnProcess: spawn,
  resolveCommand: resolveCodexCommand,
  readStatus: readCodexStateDbBackfillStatus,
  countSessions: countCodexSessionFilesUpTo,
  now: Date.now,
  sleep: async (ms, signal) => await delay(ms, undefined, { signal }),
  terminate: async (child) => await terminateCodexProbeChild(child)
}

function finish(
  outcome: CodexStateDbBackfillRecoverySummary['outcome'],
  spawnCount: number
): CodexStateDbBackfillRecoverySummary {
  return { outcome, spawnCount }
}

function initialRecoveryDecision(
  codexHomePath: string,
  dependencies: RecoveryDependencies
): CodexStateDbBackfillRecoverySummary['outcome'] | null {
  const status = dependencies.readStatus(codexHomePath)
  if (status.kind === 'complete') {
    return 'already-complete'
  }
  if (status.kind === 'unreadable') {
    return 'unreadable'
  }
  if (
    (status.kind === 'missing' || status.kind === 'not-tracked') &&
    dependencies.countSessions(
      join(codexHomePath, 'sessions'),
      BACKFILL_PENDING_MIN_SESSION_FILES
    ) < BACKFILL_PENDING_MIN_SESSION_FILES
  ) {
    return 'not-needed'
  }
  return null
}

function spawnRecoveryProcess(
  codexHomePath: string,
  dependencies: RecoveryDependencies
): ChildProcess {
  const wslHome = process.platform === 'win32' ? parseWslUncPath(codexHomePath) : null
  if (wslHome) {
    return dependencies.spawnProcess(
      'wsl.exe',
      buildWslCodexAppServerArgs(
        wslHome.distro,
        wslHome.linuxPath,
        CODEX_READ_ONLY_APP_SERVER_ARGS
      ),
      {
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
        env: process.env
      }
    )
  }
  const command = dependencies.resolveCommand()
  const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(command, [
    ...CODEX_READ_ONLY_APP_SERVER_ARGS
  ])
  return dependencies.spawnProcess(spawnCmd, spawnArgs, {
    cwd: codexHomePath,
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
    env: { ...process.env, CODEX_HOME: codexHomePath }
  })
}

/** Keeps a sanctioned app-server claimant alive until Codex completes its own backfill. */
export async function runCodexStateDbBackfillRecovery(
  codexHomePath: string,
  signal: AbortSignal,
  dependenciesOverride: Partial<RecoveryDependencies> = {}
): Promise<CodexStateDbBackfillRecoverySummary> {
  const dependencies = { ...defaultDependencies, ...dependenciesOverride }
  const initialOutcome = initialRecoveryDecision(codexHomePath, dependencies)
  if (initialOutcome) {
    return finish(initialOutcome, 0)
  }

  const deadline = dependencies.now() + RECOVERY_MAX_TOTAL_MS
  let spawnCount = 0
  while (!signal.aborted && dependencies.now() < deadline && spawnCount < RECOVERY_MAX_SPAWNS) {
    const child = spawnRecoveryProcess(codexHomePath, dependencies)
    spawnCount += 1
    let childDown = false
    child.once('error', () => {
      childDown = true
    })
    child.once('exit', () => {
      childDown = true
    })

    try {
      while (!childDown && !signal.aborted && dependencies.now() < deadline) {
        await dependencies.sleep(RECOVERY_POLL_INTERVAL_MS, signal)
        const status = dependencies.readStatus(codexHomePath)
        if (status.kind === 'complete') {
          await dependencies.terminate(child)
          return finish('completed', spawnCount)
        }
        if (status.kind === 'unreadable') {
          await dependencies.terminate(child)
          return finish('unreadable', spawnCount)
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        await dependencies.terminate(child)
        throw error
      }
    }

    if (signal.aborted) {
      await dependencies.terminate(child)
      return finish('stopped', spawnCount)
    }
    if (!childDown) {
      await dependencies.terminate(child)
      return finish('gave-up', spawnCount)
    }
    if (spawnCount >= RECOVERY_MAX_SPAWNS) {
      return finish('gave-up', spawnCount)
    }
    try {
      await dependencies.sleep(RECOVERY_RETRY_DELAY_MS, signal)
    } catch {
      return finish('stopped', spawnCount)
    }
  }
  return finish(signal.aborted ? 'stopped' : 'gave-up', spawnCount)
}

export function resolveCodexBackfillSupervisorLockRoot(codexHomePath: string): string {
  const homeKey = normalizeRuntimePathForComparison(codexHomePath)
  const digest = createHash('sha256').update(homeKey).digest('hex')
  return join(getOrcaUserDataPath(), 'codex-state-db-backfill-locks', digest)
}

function scopeRecoveryHostIdentity(hostIdentity: string, codexHomePath: string): string {
  const wslHome = process.platform === 'win32' ? parseWslUncPath(codexHomePath) : null
  return wslHome ? `${hostIdentity}:wsl:${wslHome.distro.toLowerCase()}` : hostIdentity
}

export async function withCodexBackfillSupervisorLock<T>(
  codexHomePath: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>
): Promise<T> {
  const hostIdentity = scopeRecoveryHostIdentity(await readManagedHookHostIdentity(), codexHomePath)
  // Reuse the crash-safe hard-link claim protocol; its storage root is Codex-specific.
  return await withManagedHookInstallLock(
    resolveCodexBackfillSupervisorLockRoot(codexHomePath),
    signal,
    run,
    hostIdentity,
    { waitTimeoutMs: RECOVERY_OWNER_CHECK_TIMEOUT_MS }
  )
}

type ActiveRecovery = {
  controller: AbortController
  ready: Promise<void>
  task: Promise<CodexStateDbBackfillRecoverySummary | null>
}

const activeRecoveries = new Map<string, ActiveRecovery>()
const coordinatorFailureCounts = new Map<string, number>()
let stopping = false

type RecoveryCoordinatorDependencies = {
  isPending: typeof isCodexStateDbBackfillPending
  run: typeof runCodexStateDbBackfillRecovery
  withLock: typeof withCodexBackfillSupervisorLock
}

const defaultCoordinatorDependencies: RecoveryCoordinatorDependencies = {
  isPending: isCodexStateDbBackfillPending,
  run: runCodexStateDbBackfillRecovery,
  withLock: withCodexBackfillSupervisorLock
}

function settleRecoveryEntry(
  key: string,
  task: ActiveRecovery['task'],
  summary: CodexStateDbBackfillRecoverySummary | null
): void {
  if (activeRecoveries.get(key)?.task !== task) {
    return
  }
  if (summary?.outcome === 'gave-up') {
    coordinatorFailureCounts.delete(key)
    return
  }
  if (summary === null) {
    const failureCount = (coordinatorFailureCounts.get(key) ?? 0) + 1
    if (failureCount >= RECOVERY_MAX_COORDINATOR_FAILURES) {
      coordinatorFailureCounts.delete(key)
      return
    }
    coordinatorFailureCounts.set(key, failureCount)
  } else {
    coordinatorFailureCounts.delete(key)
  }
  activeRecoveries.delete(key)
}

export function startCodexStateDbBackfillRecoveryInBackground(
  codexHomePath: string,
  dependenciesOverride: Partial<RecoveryCoordinatorDependencies> = {}
): Promise<CodexStateDbBackfillRecoverySummary | null> {
  const dependencies = { ...defaultCoordinatorDependencies, ...dependenciesOverride }
  const key = normalizeRuntimePathForComparison(codexHomePath)
  const existing = activeRecoveries.get(key)
  if (existing) {
    return existing.task
  }
  if (stopping) {
    return Promise.resolve(null)
  }
  if (!dependencies.isPending(codexHomePath)) {
    coordinatorFailureCounts.delete(key)
    return Promise.resolve(null)
  }
  const controller = new AbortController()
  let markReady!: () => void
  const ready = new Promise<void>((resolve) => (markReady = resolve))
  const task = dependencies
    .withLock(codexHomePath, controller.signal, async () => {
      console.info(`[codex-state-db-backfill] supervising Codex index at ${codexHomePath}`)
      markReady()
      return await dependencies.run(codexHomePath, controller.signal)
    })
    .catch((error: unknown) => {
      if (!controller.signal.aborted) {
        console.warn('[codex-state-db-backfill] recovery supervisor stopped:', error)
      }
      return null
    })
  void task.finally(markReady)
  activeRecoveries.set(key, { controller, ready, task })
  void task.then((summary) => {
    settleRecoveryEntry(key, task, summary)
  })
  return task
}

/** Waits only for exact-owner arbitration, never for the potentially long Codex index. */
export async function ensureCodexStateDbBackfillRecoveryStarted(
  codexHomePath: string
): Promise<void> {
  void startCodexStateDbBackfillRecoveryInBackground(codexHomePath)
  await activeRecoveries.get(normalizeRuntimePathForComparison(codexHomePath))?.ready
}

export async function stopCodexStateDbBackfillRecoveries(): Promise<void> {
  stopping = true
  const recoveries = [...activeRecoveries.values()]
  for (const recovery of recoveries) {
    recovery.controller.abort()
  }
  await Promise.allSettled(recoveries.map(({ task }) => task))
}

export const _internals = {
  resetForTests(): void {
    stopping = false
    activeRecoveries.clear()
    coordinatorFailureCounts.clear()
  }
}
