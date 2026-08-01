import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { resolveCodexCommand } from '../codex-cli/command'
import { getSpawnArgsForWindows } from '../win32-utils'
import { killCodexAppServerProcessTree } from './codex-app-server-session'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from './codex-home-paths'
import type { CodexSessionBackfillOptions } from './codex-session-backfill-types'
import {
  BACKFILL_PENDING_MIN_SESSION_FILES,
  countCodexSessionFilesUpTo,
  readCodexStateDbBackfillStatus,
  type CodexStateDbBackfillStatus
} from './codex-state-db'

// Why: mirrors codex-fetcher's headless invocation; app-server idles on stdin and runs
// Codex's startup state-db backfill without needing a TUI or a model turn.
export const PREWARM_CODEX_ARGS: readonly string[] = [
  '-s',
  'read-only',
  '-a',
  'untrusted',
  'app-server'
]
// Why alias: the trust-grant deferral and the prewarm must agree on what "large
// enough to stall codex" means, or one can defer forever waiting on the other.
export const PREWARM_MIN_SESSION_FILES = BACKFILL_PENDING_MIN_SESSION_FILES
export const PREWARM_POLL_INTERVAL_MS = 5_000
export const PREWARM_SPAWN_RETRY_DELAY_MS = 2_000
// Why: verified codex 0.146 — a non-claimant app-server exits ~30s after start (another
// process holds the backfill lease, or a stale lease <=900s after an unclean kill). Those
// exits are expected and self-heal; only children dying before codex's own 30s gate
// (< PREWARM_FAST_EXIT_MS) count as failures.
export const PREWARM_FAST_EXIT_MS = 10_000
export const PREWARM_MAX_SPAWNS = 5 // budget for fast failures only; deadline bounds the rest
// Why: reporter's 15 GB history took ~25 min; 60 min bounds pathological cases.
export const PREWARM_MAX_TOTAL_MS = 60 * 60_000

export type CodexStateDbPrewarmOutcome =
  | 'completed'
  | 'already-complete'
  | 'not-needed'
  | 'skipped-unreadable'
  | 'stopped'
  | 'gave-up'
  | 'codex-unavailable'

export type CodexStateDbPrewarmSummary = {
  outcome: CodexStateDbPrewarmOutcome
  spawnCount: number
  elapsedMs: number
}

export type CodexStateDbPrewarmDeps = {
  resolveCommand: () => string
  spawnProcess: typeof spawn
  readBackfillStatus: (codexHomePath: string) => CodexStateDbBackfillStatus
  countSessionFiles: (sessionsRoot: string, limit: number) => number
  now: () => number
  sleep: (ms: number) => Promise<void>
  logger: Pick<Console, 'warn' | 'info'>
}

const defaultDeps: CodexStateDbPrewarmDeps = {
  resolveCommand: () => resolveCodexCommand(),
  spawnProcess: spawn,
  readBackfillStatus: readCodexStateDbBackfillStatus,
  countSessionFiles: countCodexSessionFilesUpTo,
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logger: console
}

/**
 * Keeps a hidden headless codex alive against `codexHomePath` until Codex's
 * one-time session index (backfill_state in state_<N>.sqlite) reads complete.
 * Without this, panes only give the index 30s slices and it never finishes
 * on large histories (#11828). Local homes only — WSL/SSH remotes are out of scope.
 */
export async function runCodexStateDbPrewarm(
  codexHomePath: string,
  options: CodexSessionBackfillOptions = {},
  depsOverride: Partial<CodexStateDbPrewarmDeps> = {}
): Promise<CodexStateDbPrewarmSummary> {
  const deps: CodexStateDbPrewarmDeps = { ...defaultDeps, ...depsOverride }
  const startedAt = deps.now()
  const finish = (
    outcome: CodexStateDbPrewarmOutcome,
    spawnCount: number
  ): CodexStateDbPrewarmSummary => ({
    outcome,
    spawnCount,
    elapsedMs: deps.now() - startedAt
  })
  const shouldStop = (): boolean => options.shouldStop?.() === true

  const status = deps.readBackfillStatus(codexHomePath)
  if (status.kind === 'complete') {
    return finish('already-complete', 0)
  }
  if (status.kind === 'unreadable') {
    // Why: never spawn against a DB we cannot even read — #11830's corruption path.
    deps.logger.warn(
      `[codex-state-db-prewarm] state db unreadable at ${status.stateDbPath}; skipping prewarm: ${status.error}`
    )
    return finish('skipped-unreadable', 0)
  }
  // Why: the pending predicate calls not-tracked+large "pending"; the prewarm
  // must agree or a deferral/pane gate could engage with no mechanism that
  // ever completes the index (#11828 deadlock).
  if (
    (status.kind === 'missing' || status.kind === 'not-tracked') &&
    deps.countSessionFiles(join(codexHomePath, 'sessions'), PREWARM_MIN_SESSION_FILES) <
      PREWARM_MIN_SESSION_FILES
  ) {
    return finish('not-needed', 0)
  }

  deps.logger.info(
    `[codex-state-db-prewarm] pre-warming codex session index at ${codexHomePath} (this can take minutes on large histories)`
  )
  const deadline = startedAt + PREWARM_MAX_TOTAL_MS
  let spawnCount = 0
  let fastFailureCount = 0
  while (true) {
    if (shouldStop()) {
      return finish('stopped', spawnCount)
    }
    if (deps.now() >= deadline || fastFailureCount >= PREWARM_MAX_SPAWNS) {
      deps.logger.warn(
        `[codex-state-db-prewarm] giving up after ${spawnCount} spawn(s); index still incomplete`
      )
      return finish('gave-up', spawnCount)
    }
    const child = spawnPrewarmCodex(codexHomePath, deps)
    const spawnedAt = deps.now()
    spawnCount += 1
    let childDown = false
    let spawnFailed = false
    // Why capture the timestamp inside the listeners: lifetime must be measured at the
    // exit event itself. Measuring at the next poll wakeup quantizes lifetime to 5s
    // multiples, so a genuine crash in the 5-10s window would read as >=10s and be
    // misclassified as an expected claim-blocked exit — respawning a crashing codex
    // every few seconds until the 60-min deadline.
    let exitedAt = spawnedAt
    child.once('error', (error) => {
      childDown = true
      spawnFailed = true
      exitedAt = deps.now()
      deps.logger.warn('[codex-state-db-prewarm] codex spawn failed:', error)
    })
    child.once('exit', () => {
      childDown = true
      exitedAt = deps.now()
    })

    while (!childDown) {
      await deps.sleep(PREWARM_POLL_INTERVAL_MS)
      if (shouldStop()) {
        terminate(child)
        return finish('stopped', spawnCount)
      }
      const polled = deps.readBackfillStatus(codexHomePath)
      if (polled.kind === 'complete') {
        terminate(child)
        deps.logger.info('[codex-state-db-prewarm] codex session index complete')
        return finish('completed', spawnCount)
      }
      if (deps.now() >= deadline) {
        terminate(child)
        return finish('gave-up', spawnCount)
      }
    }
    if (spawnFailed && spawnCount === 1) {
      // Why: first spawn ENOENT means no usable codex binary; retries cannot help.
      return finish('codex-unavailable', spawnCount)
    }
    // Why: claim-blocked exits (~30s, verified) are expected — respawn until the
    // deadline; only fast deaths burn the failure budget, measured at the exit event
    // (exitedAt), never at poll detection.
    if (exitedAt - spawnedAt < PREWARM_FAST_EXIT_MS) {
      fastFailureCount += 1
    }
    await deps.sleep(PREWARM_SPAWN_RETRY_DELAY_MS)
  }
}

function terminate(child: ChildProcess): void {
  try {
    // Why: app-server exits promptly on stdin EOF once initialized — try that first.
    child.stdin?.end()
    if (process.platform === 'win32') {
      // Why: child.kill() only reaches the .cmd/cmd.exe wrapper on Windows and orphans
      // codex.exe — kill the tree.
      killCodexAppServerProcessTree(child)
      return
    }
    // Why: a mid-index claimer blocks in init before the stdin transport runs, so EOF
    // alone may not stop it. SIGTERM never corrupts the DB (verified), but leaves a
    // stale backfill lease: codex starts against this home fail at ~30s for <=900s,
    // then the next claimer resumes from the watermark.
    child.kill()
  } catch {
    // Why: the child may exit between the poll and the kill.
  }
}

function spawnPrewarmCodex(codexHomePath: string, deps: CodexStateDbPrewarmDeps): ChildProcess {
  const command = deps.resolveCommand()
  // Why: .cmd/.bat launchers can't be spawned directly and shell:true triggers DEP0190 — route them through cmd.exe /c.
  const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(command, [...PREWARM_CODEX_ARGS])
  return deps.spawnProcess(spawnCmd, spawnArgs, {
    cwd: codexHomePath,
    // Why: hold stdin open so app-server idles instead of exiting on stdin EOF; never write to it.
    stdio: ['pipe', 'ignore', 'ignore'],
    // Why windowsHide: without it, background cmd.exe /c spawns flash a console window on Windows.
    windowsHide: true,
    env: { ...process.env, CODEX_HOME: codexHomePath }
  })
}

/**
 * Prewarms both local homes panes actually use, in order:
 * 1. the system home (fresh panes on the real-home lane read it — same target the
 *    index-heal stage pins; default resolved via the same getSystemCodexHomePath()
 *    fallback its backfill paths use), then
 * 2. the managed home (resume-pinned panes read it).
 * Why both: with the real-home lane selected, fresh panes get NO managed CODEX_HOME
 * (runtime-home-service.ts returns null) — see ledger A10/AD-3.
 */
async function runDualHomePrewarm(
  options: CodexSessionBackfillOptions,
  systemCodexHomePathOverride?: string
): Promise<CodexStateDbPrewarmSummary[]> {
  const systemHome = systemCodexHomePathOverride || getSystemCodexHomePath()
  const managedHome = getOrcaManagedCodexHomePath()
  const homes = [systemHome, managedHome].filter(
    (home, index, all): home is string => typeof home === 'string' && all.indexOf(home) === index
  )
  const summaries: CodexStateDbPrewarmSummary[] = []
  for (const home of homes) {
    if (options.shouldStop?.() === true) {
      break
    }
    summaries.push(await runCodexStateDbPrewarm(home, options))
  }
  return summaries
}

let backgroundPrewarmTask: Promise<CodexStateDbPrewarmSummary[] | null> | null = null

/** Single-flight background wrapper matching the migration-scheduler MigrationRun shape. */
export function startCodexStateDbPrewarmInBackground(
  options: CodexSessionBackfillOptions = {},
  systemCodexHomePathOverride?: string
): Promise<CodexStateDbPrewarmSummary[] | null> {
  if (backgroundPrewarmTask) {
    return backgroundPrewarmTask
  }
  const task = runDualHomePrewarm(options, systemCodexHomePathOverride)
    .catch((error: unknown) => {
      console.warn('[codex-state-db-prewarm] Background prewarm failed:', error)
      return null
    })
    .finally(() => {
      if (backgroundPrewarmTask === task) {
        backgroundPrewarmTask = null
      }
    })
  backgroundPrewarmTask = task
  return task
}
