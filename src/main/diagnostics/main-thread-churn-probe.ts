import { writeStartupDiagnosticLine } from '../startup/startup-diagnostics'

export const MAIN_THREAD_DIAGNOSTICS_ENV = 'ORCA_MAIN_THREAD_DIAGNOSTICS'

// Why: 25ms mirrors event-loop-stall-probe — a timer that fires late by N ms
// proves the main thread was blocked for N ms, which is the direct in-process
// measurement of the macOS "Performance Diagnostics" main-thread warnings
// reported in issue #7576.
const TICK_MS = 25
const REPORT_EVERY_MS = 5_000

export function isMainThreadDiagnosticsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MAIN_THREAD_DIAGNOSTICS_ENV] === '1'
}

// Git global options that precede the subcommand. Value-taking flags must be
// skipped together with their value to find the real subcommand.
const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--exec-path'])

// Why: only subcommand-style CLIs get a "<binary> <subcommand>" bucket; for
// anything else (rg, node, …) the first positional is an operand, not a
// subcommand, and would fragment the aggregation.
const SUBCOMMAND_BINARIES = new Set(['git', 'gh', 'glab'])

/**
 * Reduce a resolved spawn to a stable aggregation key like "git status" or
 * "gh api". Handles WSL wrapping (`wsl.exe -d <distro> -- git …`), absolute
 * binary paths, `.exe` suffixes, and git global flags before the subcommand.
 */
// Split on both separators so Windows-style paths classify correctly even
// when the classifier itself runs in a posix test environment.
function binaryName(command: string): string {
  const leaf = command.split(/[\\/]/).pop() ?? command
  return leaf.replace(/\.exe$/i, '').toLowerCase()
}

export function classifySubprocessCommand(command: string, args: readonly string[]): string {
  let binary = binaryName(command)
  const rest = [...args]
  if (binary === 'wsl') {
    while (rest.length > 0) {
      const arg = rest.shift()
      if (arg === '--') {
        break
      }
    }
    const unwrapped = rest.shift()
    if (!unwrapped) {
      return 'wsl'
    }
    binary = binaryName(unwrapped)
  }
  if (!SUBCOMMAND_BINARIES.has(binary)) {
    return binary
  }
  let subcommand: string | null = null
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (!arg.startsWith('-')) {
      subcommand = arg
      break
    }
    // Why: only git's global flags take a separate value; e.g. rg's -C takes
    // a number that must not be consumed as if it were a flag value.
    if (binary === 'git' && GIT_VALUE_FLAGS.has(arg)) {
      i++
    }
  }
  if (!subcommand) {
    return binary
  }
  return `${binary} ${subcommand.slice(0, 40)}`
}

export type SubprocessSpawnStats = {
  count: number
  // Cumulative and worst synchronous cost of initiating the spawn (the
  // uv_spawn → posix_spawn call runs on the main thread before returning).
  blockMsTotal: number
  blockMsMax: number
}

const spawnStatsByCommand = new Map<string, SubprocessSpawnStats>()

/**
 * Record one subprocess spawn from the main process. `blockMs` is how long
 * the synchronous spawn/execFile initiation call held the main thread.
 * No-op unless ORCA_MAIN_THREAD_DIAGNOSTICS=1.
 */
export function recordSubprocessSpawn(
  command: string,
  args: readonly string[],
  blockMs: number
): void {
  if (!isMainThreadDiagnosticsEnabled()) {
    return
  }
  const key = classifySubprocessCommand(command, args)
  const stats = spawnStatsByCommand.get(key)
  if (stats) {
    stats.count++
    stats.blockMsTotal += blockMs
    stats.blockMsMax = Math.max(stats.blockMsMax, blockMs)
  } else {
    spawnStatsByCommand.set(key, { count: 1, blockMsTotal: blockMs, blockMsMax: blockMs })
  }
}

export function drainSubprocessSpawnStats(): Record<string, SubprocessSpawnStats> {
  const drained: Record<string, SubprocessSpawnStats> = {}
  for (const [key, stats] of spawnStatsByCommand) {
    drained[key] = {
      count: stats.count,
      blockMsTotal: Math.round(stats.blockMsTotal * 100) / 100,
      blockMsMax: Math.round(stats.blockMsMax * 100) / 100
    }
  }
  spawnStatsByCommand.clear()
  return drained
}

/**
 * Timestamped marker line for correlating a specific main-process activity
 * (e.g. an updater check) with the probe's stall windows and with macOS
 * Performance Diagnostics log entries in field captures. No-op unless
 * ORCA_MAIN_THREAD_DIAGNOSTICS=1.
 */
export function writeMainThreadDiagnosticMarker(marker: string): void {
  if (!isMainThreadDiagnosticsEnabled()) {
    return
  }
  writeStartupDiagnosticLine(
    `[main-thread] ${JSON.stringify({ marker, t: Math.round(performance.now()) })}`
  )
}

/**
 * Long-running main-process jank probe for benchmarks and field diagnosis of
 * issue #7576. Every 5s emits one `[main-thread] {json}` stderr line with the
 * window's worst event-loop stall, stall counts over 50/250ms, and drained
 * subprocess spawn stats. Unlike the startup stall probe this never stops:
 * the churn it measures (git status polling, updater retries) is steady-state.
 */
export function startMainThreadChurnProbe(): void {
  if (!isMainThreadDiagnosticsEnabled()) {
    return
  }
  let last = performance.now()
  let lastReport = last
  let windowMaxGapMs = 0
  let gapsOver50Ms = 0
  let gapsOver250Ms = 0
  const timer = setInterval(() => {
    const now = performance.now()
    const gap = now - last - TICK_MS
    last = now
    if (gap > windowMaxGapMs) {
      windowMaxGapMs = gap
    }
    if (gap > 50) {
      gapsOver50Ms++
    }
    if (gap > 250) {
      gapsOver250Ms++
    }
    if (now - lastReport < REPORT_EVERY_MS) {
      return
    }
    lastReport = now
    const spawns = drainSubprocessSpawnStats()
    const report = {
      t: Math.round(now),
      maxGapMs: Math.max(0, Math.round(windowMaxGapMs)),
      gapsOver50Ms,
      gapsOver250Ms,
      spawnCount: Object.values(spawns).reduce((sum, s) => sum + s.count, 0),
      spawns
    }
    windowMaxGapMs = 0
    gapsOver50Ms = 0
    gapsOver250Ms = 0
    writeStartupDiagnosticLine(`[main-thread] ${JSON.stringify(report)}`)
  }, TICK_MS)
  timer.unref?.()
}
