import { runProcess } from '@orca/process-host'
import {
  readWindowsProcessTable,
  type WindowsProcessRow as NativeWindowsProcessRow
} from '../windows/windows-process-table'

// Keep argv/start-time discovery independent of Electron’s memory collector for hook-process use.

export type ProcessIdentityRow = {
  pid: number
  ppid: number
  startedAtMs: number
  /** Kernel executable name preserves spaces lost by reconstructed args; empty falls back to argv[0]. */
  executable: string
  /** Reconstructed command-line approximation, not exact argument boundaries. */
  argv: string[]
}

const SWEEP_TIMEOUT_MS = 5_000
const SWEEP_MAX_BYTES = 10 * 1024 * 1024

/** Convert ps elapsed time ([[dd-]hh:]mm:ss) to epoch start milliseconds; null for unknown formats. */
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

/** Group quoted paths; escaped quotes and unquoted spaces cannot preserve argv boundaries.
 * Use kernel executable names for classification; argv is for flag-adjacent values. */
export function splitCommandLineArgv(commandLine: string): string[] {
  const argv: string[] = []
  const pattern = /"([^"]*)"|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(commandLine)) !== null) {
    argv.push(match[1] ?? match[2] ?? '')
  }
  return argv.filter((part) => part.length > 0)
}

/** Parse reconstructed args, leaving executable empty for the comm join. */
export function parsePsArgsLine(line: string, nowMs: number): ProcessIdentityRow | null {
  // A split limit discards the remaining arguments.
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
  return { pid, ppid, startedAtMs, executable: '', argv }
}

/** Keep all text after pid: kernel executable names can contain spaces. */
export function parsePsCommLine(line: string): { pid: number; executable: string } | null {
  const match = line.trim().match(/^(\S+)\s+([\s\S]*\S)\s*$/)
  if (!match) {
    return null
  }
  const [, pidText, executable] = match
  const pid = Number.parseInt(pidText ?? '', 10)
  if (!Number.isFinite(pid) || !executable) {
    return null
  }
  return { pid, executable }
}

/** Skip rows without kernel creation times because session bracketing requires them. */
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
  return {
    pid: row.pid,
    ppid: row.ppid,
    startedAtMs: row.creationTimeMs,
    executable: row.name,
    argv
  }
}

function executableBaseName(value: string): string {
  const bare = value.split(/[\\/]/).at(-1) ?? ''
  return bare.toLowerCase().replace(/\.exe$/, '')
}

function argvZeroBase(argv: readonly string[]): string {
  return executableBaseName(argv[0] ?? '')
}

export function isOpenCodeClientArgv(argv: readonly string[]): boolean {
  return isOpenCodeClientProcess({ executable: '', argv })
}

/** Prefer kernel executable names: reconstructed argv[0] may truncate paths containing spaces. */
export function isOpenCodeClientProcess(row: {
  executable: string
  argv: readonly string[]
}): boolean {
  const classified =
    row.executable && row.executable.length > 0
      ? executableBaseName(row.executable)
      : argvZeroBase(row.argv)
  if (classified !== 'opencode') {
    return false
  }
  // Binding the shared daemon as a pane client would misattribute the posts being corrected.
  return !row.argv.some((part) => part === 'serve' || part === '--service')
}

/** Fail open to an empty process list. */
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
      // Use the native Windows process reader; whole-table PowerShell/CIM scans are retired.
      const readTable = deps.readWindowsTable ?? readWindowsProcessTable
      const rows = await readTable()
      return rows
        .map((row) => nativeWindowsRowToIdentity(row))
        .filter((row): row is ProcessIdentityRow => row !== null)
    }
    const stdout = await execFileText(run, 'ps', ['-eo', 'pid=,ppid=,etime=,args='])
    const rows = stdout
      .split('\n')
      .map((line) => parsePsArgsLine(line, nowMs))
      .filter((row): row is ProcessIdentityRow => row !== null)
    // Read comm separately to preserve executable spaces; failures fall back to argv[0].
    try {
      const commOut = await execFileText(run, 'ps', ['-eo', 'pid=,comm='])
      const executables = new Map<number, string>()
      for (const line of commOut.split('\n')) {
        const parsed = parsePsCommLine(line)
        if (parsed && !executables.has(parsed.pid)) {
          executables.set(parsed.pid, parsed.executable)
        }
      }
      for (const row of rows) {
        const executable = executables.get(row.pid)
        if (executable) {
          row.executable = executable
        }
      }
    } catch (err) {
      console.warn('[opencode-binder] comm sweep failed; classifying from argv', err)
    }
    return rows
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
