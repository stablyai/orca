import { runProcess, runProcessSync } from '../../shared/child-process/run-process'
import type { ProcessResult } from '../../shared/child-process/run-process'

const PROCESS_TABLE_LOOKUP_TIMEOUT_MS = 250
const PROCESS_TABLE_QUERY_TIMEOUT_MS = PROCESS_TABLE_LOOKUP_TIMEOUT_MS / 2
const PROCESS_TABLE_MAX_BYTES = 64 * 1024

export type PosixPtyForegroundGroupDeps = {
  platform?: NodeJS.Platform
  currentPid?: number
  readProcessTable?: () => string
}

type ProcessRow = {
  pid: number
  tpgid: number
  tty: string
}

/** `ps` prints `ttys003` / `pts/3`; node-pty reports `/dev/ttys003` / `/dev/pts/3`. */
function normalizeTty(value: string): string {
  return value.replace(/^\/dev\//, '')
}

function hasUsableTty(tty: string): boolean {
  return tty !== '?' && tty !== '??' && tty !== '-'
}

function psSpec(pid: number): {
  program: string
  args: string[]
  timeoutMs: number
  maxOutputBytes: number
} {
  return {
    program: 'ps',
    args: ['-p', String(pid), '-o', 'pid=,tpgid=,tty='],
    timeoutMs: PROCESS_TABLE_QUERY_TIMEOUT_MS,
    maxOutputBytes: PROCESS_TABLE_MAX_BYTES
  }
}

/** Why throw: callers read a failed `ps` as "no foreground group", which `runProcess` reports as a non-zero code rather than a rejection. */
function requirePsStdout(result: ProcessResult): string {
  if (result.timedOut || result.code !== 0) {
    throw new Error(`ps exited with code ${result.code ?? 'unknown'}`)
  }
  return result.stdout
}

let ownRowCache: { pid: number; row: string } | null = null

/**
 * Orca's own row, read once per process. It feeds exactly one guard — the
 * "does this process share the PTY" check below — and the only field that guard
 * reads is the controlling tty, which cannot change for a process's lifetime.
 * Re-forking `ps` for it on every SIGWINCH doubled a ~3ms synchronous stall that
 * the renderer fires twice per revealed pane.
 */
function readOwnProcessRow(currentPid: number): string {
  if (ownRowCache?.pid !== currentPid) {
    // A throw is not cached: the caller already treats a failed read as "no group".
    ownRowCache = { pid: currentPid, row: requirePsStdout(runProcessSync(psSpec(currentPid))) }
  }
  return ownRowCache.row
}

async function readOwnProcessRowAsync(currentPid: number): Promise<string> {
  if (ownRowCache?.pid !== currentPid) {
    const row = requirePsStdout(await runProcess(psSpec(currentPid)))
    ownRowCache = { pid: currentPid, row }
  }
  return ownRowCache.row
}

/** Test seam: the cache is keyed by pid, but tests reuse one pid across cases. */
export function resetPosixPtyForegroundGroupOwnRowCache(): void {
  ownRowCache = null
}

/**
 * Why two rows instead of `-p a,b`: macOS `ps` only takes the KERN_PROC_PID fast
 * path for a single pid. ANY pid list — even a duplicate of one pid — walks the
 * whole process table, measured at ~3.6s on a busy machine versus ~3ms here. That
 * blew the timeout below, so the group lookup silently fell back to the very
 * root-pid delivery this module exists to replace.
 */
function readForegroundGroupTable(rootPid: number, currentPid: number): string {
  return `${requirePsStdout(runProcessSync(psSpec(rootPid)))}\n${readOwnProcessRow(currentPid)}`
}

async function readForegroundGroupTableAsync(
  rootPid: number,
  currentPid: number
): Promise<string> {
  const root = requirePsStdout(await runProcess(psSpec(rootPid)))
  return `${root}\n${await readOwnProcessRowAsync(currentPid)}`
}

function parseProcessRows(output: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(-?\d+)\s+(\S+)/.exec(line)
    if (!match) {
      continue
    }
    const pid = Number(match[1])
    if (pid > 0) {
      rows.push({ pid, tpgid: Number(match[2]), tty: match[3] })
    }
  }
  return rows
}

/**
 * Resolves the foreground process group of one PTY, which is who the kernel
 * signals on a real window-size change.
 *
 * Why not the root pid: the shell calls `setpgid` for job control, so it leaves
 * the root's group immediately, and on macOS the root is `login(1)` — which
 * neither handles nor forwards SIGWINCH. A foreground TUI is a third group
 * again, so only the tty's `tpgid` reproduces a kernel resize.
 */
export function getPosixPtyForegroundGroup(
  output: string,
  rootPid: number,
  ptsName: string,
  currentPid = process.pid
): number | null {
  const rows = parseProcessRows(output)
  const root = rows.find((row) => row.pid === rootPid)
  if (!root || !hasUsableTty(root.tty)) {
    return null
  }
  // Why: `ps -p` answers for whatever owns the pid now. Without pinning the tty we
  // captured at spawn, a recycled pid could aim a group signal at a real terminal.
  if (normalizeTty(root.tty) !== normalizeTty(ptsName)) {
    return null
  }
  // Why: a development daemon can inherit its launch TTY. Never group-signal when
  // this process shares the PTY; fall back to the already-scoped root signal.
  if (rows.some((row) => row.pid === currentPid && row.tty === root.tty)) {
    return null
  }
  // tpgid is -1 when no foreground group owns the tty, and pid 1 is never one.
  return root.tpgid > 1 ? root.tpgid : null
}

function deliverForegroundSignal(
  table: string | null,
  rootPid: number,
  ptsName: string,
  signal: NodeJS.Signals | (string & {}),
  fallback: () => void,
  currentPid: number
): void {
  const pgid = table === null ? null : getPosixPtyForegroundGroup(table, rootPid, ptsName, currentPid)
  if (pgid === null) {
    fallback()
    return
  }
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callers pass a real signal name; the widened string is only for node-pty's looser type.
    process.kill(-pgid, signal as NodeJS.Signals)
  } catch (error) {
    // Why: the group can exit between `ps` and `kill`. The fallback would be just
    // as stale, so a vanished foreground group is success, not a reason to retry.
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ESRCH') {
      fallback()
    }
  }
}

/**
 * Sends `signal` to the PTY's foreground process group, falling back to the
 * supplied root-pid delivery when the group cannot be established safely.
 *
 * Scoped to SIGWINCH by callers on purpose: a destructive signal must keep the
 * narrower root-pid target plus the descendant-sweep identity machinery.
 *
 * Narrow sync path: only for the daemon's synchronous `SubprocessHandle.signal`.
 * Anything reachable from an `ipcMain` reply must use the async twin below.
 */
export function signalPosixPtyForegroundGroup(
  rootPid: number,
  ptsName: string | undefined,
  signal: NodeJS.Signals | (string & {}),
  fallback: () => void,
  deps: PosixPtyForegroundGroupDeps = {}
): void {
  if ((deps.platform ?? process.platform) === 'win32' || !ptsName) {
    fallback()
    return
  }
  const currentPid = deps.currentPid ?? process.pid
  let table: string | null
  try {
    table = (deps.readProcessTable ?? (() => readForegroundGroupTable(rootPid, currentPid)))()
  } catch {
    table = null
  }
  deliverForegroundSignal(table, rootPid, ptsName, signal, fallback, currentPid)
}

/** Async twin, for the SIGWINCH path the renderer reaches over IPC twice per revealed pane. */
export async function signalPosixPtyForegroundGroupAsync(
  rootPid: number,
  ptsName: string | undefined,
  signal: NodeJS.Signals | (string & {}),
  fallback: () => void,
  deps: PosixPtyForegroundGroupDeps = {}
): Promise<void> {
  if ((deps.platform ?? process.platform) === 'win32' || !ptsName) {
    fallback()
    return
  }
  const currentPid = deps.currentPid ?? process.pid
  let table: string | null
  try {
    table = await (deps.readProcessTable ??
      (() => readForegroundGroupTableAsync(rootPid, currentPid)))()
  } catch {
    table = null
  }
  deliverForegroundSignal(table, rootPid, ptsName, signal, fallback, currentPid)
}
