import { runProcess } from '../../shared/child-process/run-process'
import {
  readWindowsProcessTable,
  type WindowsProcessRow as NativeWindowsProcessRow
} from '../windows/windows-process-table'

/**
 * Host-wide sweep locating live OpenCode client processes for the
 * session→pane binder (#21359).
 *
 * Why a dedicated sweep instead of reusing the memory collector's: that
 * index carries pid/ppid/cpu/rss but no argv or start times, and importing
 * the memory subsystem here would drag its Electron app-metrics dependency
 * into the hook path. On Windows the table is read only through the native
 * reader (`windows-process-table.ts`); on macOS/Linux through one `ps` call.
 * The invocation pattern (5 s timeout, 10 MB cap, fail-open []) mirrors
 * `windows-process-resource-collector.ts`.
 */

/** One process identity row from a host sweep. */
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
 * Split a command line into argv, grouping `"..."` so a quoted executable
 * path survives as argv[0]. Covers the shapes that matter here (a quoted
 * install path plus plain flags); it is not a full shell parser — an escaped
 * quote inside a quoted span still splits, and only argv[0] (classification)
 * plus flag-adjacent values (`--session <id>`) are ever read downstream.
 */
export function splitCommandLineArgv(commandLine: string): string[] {
  const argv: string[] = []
  const pattern = /"([^"]*)"|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(commandLine)) !== null) {
    argv.push(match[1] ?? match[2] ?? '')
  }
  return argv.filter((part) => part.length > 0)
}

/**
 * One `ps -eo pid=,ppid=,etime=,args=` line. `args` is the joined command
 * line; argv[0] and flag values survive quote-aware splitting, but a path
 * containing an unquoted space does not. Enough to spot an `opencode`
 * client and read its `--session` value, not enough to re-exec anything.
 */
export function parsePsArgsLine(line: string, nowMs: number): ProcessIdentityRow | null {
  // Why a regex instead of split-with-limit: split discards everything past
  // the limit, which would truncate argv to its first token.
  const match = line.trim().match(/^(\S+)\s+(\S+)\s+(\S+)\s+([\s\S]*\S)\s*$/)
  if (!match) {
    return null
  }
  const [, pidText, ppidText, etimeText, argsText] = match
  if (!pidText || !ppidText || !etimeText || !argsText) {
    return null
  }
  const pid = Number.parseInt(pidText, 10)
  const ppid = Number.parseInt(ppidText, 10)
  const startedAtMs = parsePsElapsedToMs(etimeText, nowMs)
  const argv = splitCommandLineArgv(argsText)
  if (
    !Number.isFinite(pid) ||
    !Number.isFinite(ppid) ||
    startedAtMs === null ||
    argv.length === 0
  ) {
    return null
  }
  return { pid, ppid, startedAtMs, argv }
}

/**
 * One native Windows process-table row. Rows without a kernel creation time
 * cannot bracket a session creation, so they are skipped rather than guessed.
 */
export function nativeWindowsRowToIdentity(
  row: NativeWindowsProcessRow
): ProcessIdentityRow | null {
  if (!Number.isFinite(row.pid) || !Number.isFinite(row.ppid)) {
    return null
  }
  if (typeof row.creationTimeMs !== 'number' || !Number.isFinite(row.creationTimeMs)) {
    return null
  }
  const argv = splitCommandLineArgv(row.command)
  if (argv.length === 0) {
    return null
  }
  return { pid: row.pid, ppid: row.ppid, startedAtMs: row.creationTimeMs, argv }
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
    readWindowsTable?: () => Promise<NativeWindowsProcessRow[]>
  } = {}
): Promise<ProcessIdentityRow[]> {
  const platform = deps.platform ?? process.platform
  const run = deps.run ?? runProcess
  const nowMs = deps.nowMs ?? Date.now()
  try {
    if (platform === 'win32') {
      // Why the native table and nothing else: it is the only sanctioned
      // Windows process-table reader (see windows-process-enumeration.md);
      // forking powershell.exe for a whole-table CIM scan is exactly the
      // pattern it retired.
      const readTable = deps.readWindowsTable ?? readWindowsProcessTable
      const rows = await readTable()
      return rows
        .map((row) => nativeWindowsRowToIdentity(row))
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

/** Run one child process to text, throwing on timeout or nonzero exit. */
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
