import { execFileSync } from 'node:child_process'

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

function runPs(pid: number): string {
  return execFileSync('ps', ['-p', String(pid), '-o', 'pid=,tpgid=,tty='], {
    encoding: 'utf8',
    timeout: PROCESS_TABLE_QUERY_TIMEOUT_MS,
    maxBuffer: PROCESS_TABLE_MAX_BYTES
  })
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
    ownRowCache = { pid: currentPid, row: runPs(currentPid) }
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
  return `${runPs(rootPid)}\n${readOwnProcessRow(currentPid)}`
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

/**
 * Sends `signal` to the PTY's foreground process group, falling back to the
 * supplied root-pid delivery when the group cannot be established safely.
 *
 * Scoped to SIGWINCH by callers on purpose: a destructive signal must keep the
 * narrower root-pid target plus the descendant-sweep identity machinery.
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
  let pgid: number | null
  try {
    pgid = getPosixPtyForegroundGroup(
      (deps.readProcessTable ?? (() => readForegroundGroupTable(rootPid, currentPid)))(),
      rootPid,
      ptsName,
      currentPid
    )
  } catch {
    pgid = null
  }
  if (pgid === null) {
    fallback()
    return
  }
  try {
    process.kill(-pgid, signal as NodeJS.Signals)
  } catch (error) {
    // Why: the group can exit between `ps` and `kill`. The fallback would be just
    // as stale, so a vanished foreground group is success, not a reason to retry.
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ESRCH') {
      fallback()
    }
  }
}
