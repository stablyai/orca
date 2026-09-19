import { runProcess } from '../../shared/child-process/run-process'

/**
 * Host-wide sweep locating live OpenCode client processes for the
 * session→pane binder (#21359).
 *
 * Why a dedicated sweep instead of reusing the memory collector's: that
 * index carries pid/ppid/cpu/rss but no argv or start times, and importing
 * the memory subsystem here would drag its Electron app-metrics dependency
 * into the hook path. The invocation pattern (runProcess, 5 s timeout,
 * 10 MB cap, tab-joined rows, fail-open []) mirrors
 * `windows-process-resource-collector.ts`.
 */

export type ProcessIdentityRow = {
  pid: number
  ppid: number
  /** ms epoch the process started. */
  startedAtMs: number
  /** argv approximation; see parsePsArgsLine. */
  argv: string[]
}

const SWEEP_TIMEOUT_MS = 5_000
const SWEEP_MAX_BYTES = 10 * 1024 * 1024

/** `[[dd-]hh:]mm:ss` → elapsed ms, or null when the shape is unknown. */
export function parsePsElapsedToMs(etime: string, nowMs: number): number | null {
  const match = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/)
  if (!match) {
    return null
  }
  const days = Number.parseInt(match[1] ?? '0', 10)
  const hours = Number.parseInt(match[2] ?? '0', 10)
  const minutes = Number.parseInt(match[3] ?? '0', 10)
  const seconds = Number.parseInt(match[4] ?? '0', 10)
  if ([days, hours, minutes, seconds].some((n) => !Number.isFinite(n) || n < 0)) {
    return null
  }
  return nowMs - ((days * 24 + hours) * 3_600 + minutes * 60 + seconds) * 1000
}

/**
 * One `ps -eo pid=,ppid=,etime=,args=` line. `args` is the joined command
 * line, so argv is split on runs of whitespace: argv[0] and flag values
 * survive, but paths containing spaces do not. Enough to spot an `opencode`
 * client and read its `--session` value, not enough to re-exec anything.
 */
export function parsePsArgsLine(line: string, nowMs: number): ProcessIdentityRow | null {
  const fields = line.trim().split(/\s+/)
  if (fields.length < 4) {
    return null
  }
  const [pidText, ppidText, etimeText, ...args] = fields
  if (!pidText || !ppidText || !etimeText || args.length === 0) {
    return null
  }
  const pid = Number.parseInt(pidText, 10)
  const ppid = Number.parseInt(ppidText, 10)
  const startedAtMs = parsePsElapsedToMs(etimeText, nowMs)
  if (!Number.isFinite(pid) || !Number.isFinite(ppid) || startedAtMs === null) {
    return null
  }
  return { pid, ppid, startedAtMs, argv: args }
}

/** One TSV row from the Windows CIM query below. */
export function parseCimArgsLine(line: string): ProcessIdentityRow | null {
  const [pidText, ppidText, ticksText, commandLine] = line.split('\t')
  const pid = Number.parseInt(pidText ?? '', 10)
  const ppid = Number.parseInt(ppidText ?? '', 10)
  // Why ticks: ConvertTo-Json datetime shapes vary by PowerShell version;
  // ticks are unambiguous and parse with one division.
  const startedAtMs = Number.parseInt(ticksText ?? '', 10) / 10_000 - 62_135_596_800_000
  const argv = (commandLine ?? '').split(/\s+/).filter((part) => part.length > 0)
  if (
    !Number.isFinite(pid) ||
    !Number.isFinite(ppid) ||
    !Number.isFinite(startedAtMs) ||
    argv.length === 0
  ) {
    return null
  }
  return { pid, ppid, startedAtMs, argv }
}

function argvZeroBase(argv: readonly string[]): string {
  const first = argv[0] ?? ''
  const bare = first.split(/[\\/]/).pop() ?? ''
  return bare.toLowerCase().replace(/\.exe$/, '')
}

/** True for an OpenCode TUI/CLI client process (not the `serve` daemon). */
export function isOpenCodeClientArgv(argv: readonly string[]): boolean {
  if (argvZeroBase(argv) !== 'opencode') {
    return false
  }
  // Why exclude: the shared server's posts are the ones being reattributed;
  // mistaking the daemon for a pane client would bind sessions to its pane.
  return !argv.some((part) => part === 'serve' || part === '--service')
}

/** Every process identity row on this host; fail-open [] like the memory sweeps. */
export async function sweepProcessIdentities(
  deps: {
    platform?: NodeJS.Platform
    run?: typeof runProcess
    nowMs?: number
  } = {}
): Promise<ProcessIdentityRow[]> {
  const platform = deps.platform ?? process.platform
  const run = deps.run ?? runProcess
  const nowMs = deps.nowMs ?? Date.now()
  try {
    if (platform === 'win32') {
      const stdout = await execFileText(run, 'powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; " +
          'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,CommandLine | ' +
          'ForEach-Object { try { [string]::Join([char]9, @($_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().Ticks, (($_.CommandLine -replace "`r?`n", \' \') -replace "`t", \' \'))) } catch {} }'
      ])
      return stdout
        .split('\n')
        .map((line) => parseCimArgsLine(line.trim()))
        .filter((row): row is ProcessIdentityRow => row !== null)
    }
    const stdout = await execFileText(run, 'ps', ['-eo', 'pid=,ppid=,etime=,args='])
    return stdout
      .split('\n')
      .map((line) => parsePsArgsLine(line, nowMs))
      .filter((row): row is ProcessIdentityRow => row !== null)
  } catch (err) {
    console.warn('[opencode-binder] process sweep failed; skipping round', err)
    return []
  }
}

async function execFileText(
  run: typeof runProcess,
  program: string,
  args: string[]
): Promise<string> {
  const result = await run({
    program,
    args,
    timeoutMs: SWEEP_TIMEOUT_MS,
    maxOutputBytes: SWEEP_MAX_BYTES
  })
  if (result.timedOut || result.code !== 0) {
    throw new Error(`${program} exited ${result.code ?? 'on timeout'}`)
  }
  return result.stdout
}
