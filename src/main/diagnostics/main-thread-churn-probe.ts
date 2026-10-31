import { writeStartupDiagnosticLine } from '../startup/startup-diagnostics'

export const MAIN_THREAD_DIAGNOSTICS_ENV = 'ORCA_MAIN_THREAD_DIAGNOSTICS'

// Match the startup probe's 25ms sampling interval for comparable stall windows.
const TICK_MS = 25
const REPORT_EVERY_MS = 5_000

export function isMainThreadDiagnosticsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MAIN_THREAD_DIAGNOSTICS_ENV] === '1'
}

// Skip Git global options together with their separate values.
const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--exec-path'])

// Operand-based CLIs would fragment aggregation if bucketed by their first positional.
const SUBCOMMAND_BINARIES = new Set(['git', 'gh', 'glab'])

// Accept both path separators even when classifying foreign-platform commands.
function binaryName(command: string): string {
  const leaf = command.split(/[\\/]/).pop() ?? command
  return leaf.replace(/\.exe$/i, '').toLowerCase()
}

export function classifySubprocessCommand(command: string, args: readonly string[]): string {
  let binary = binaryName(command)
  const rest = [...args]
  if (binary === 'wsl') {
    // Accept external WSL invocations using -- or -e as well as Orca's --exec.
    while (rest.length > 0) {
      const arg = rest.shift()
      if (arg === '--' || arg === '--exec' || arg === '-e') {
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
  // Async launches measure spawn initiation; synchronous launches measure the entire run.
  blockMsTotal: number
  blockMsMax: number
}

const spawnStatsByCommand = new Map<string, SubprocessSpawnStats>()

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

/** Correlate process activity with stall windows and captured macOS diagnostics. */
export function writeMainThreadDiagnosticMarker(marker: string): void {
  if (!isMainThreadDiagnosticsEnabled()) {
    return
  }
  writeStartupDiagnosticLine(
    `[main-thread] ${JSON.stringify({ marker, t: Math.round(performance.now()) })}`
  )
}

export type MainThreadChurnProbeOptions = {
  /** Extra counters folded into each report line, sampled once per window. */
  extraStats?: () => Record<string, unknown>
}

/** Unlike the startup probe, report steady-state stalls and subprocess costs throughout the session. */
export function startMainThreadChurnProbe(options: MainThreadChurnProbeOptions = {}): void {
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
      spawns,
      ...options.extraStats?.()
    }
    windowMaxGapMs = 0
    gapsOver50Ms = 0
    gapsOver250Ms = 0
    writeStartupDiagnosticLine(`[main-thread] ${JSON.stringify(report)}`)
  }, TICK_MS)
  timer.unref?.()
}
