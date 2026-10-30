import { runProcess } from '@orca/process-host'
import { inProcessSliceMs, runPsInProcess } from '../../shared/libproc-process-table'

const PROCESS_TABLE_LOOKUP_TIMEOUT_MS = 250
const PROCESS_TABLE_QUERY_TIMEOUT_MS = PROCESS_TABLE_LOOKUP_TIMEOUT_MS / 2
const PROCESS_TABLE_MAX_BYTES = 64 * 1024

export type PosixPtyForegroundGroupDeps = {
  platform?: NodeJS.Platform
  currentPid?: number
  readProcessTable?: () => Promise<string>
  /** False once the root has exited; a stale table could then name a recycled group. */
  ownsRoot?: () => boolean
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

async function runPs(pid: number): Promise<string> {
  const args = ['-p', String(pid), '-o', 'pid=,tpgid=,tty=']
  // A native read stuck behind a busy pool leaves ps its full timeout before signalling.
  const inProcess = await runPsInProcess(args, {
    timeoutMs: inProcessSliceMs(PROCESS_TABLE_QUERY_TIMEOUT_MS),
    maxOutputBytes: PROCESS_TABLE_MAX_BYTES
  })
  const result =
    inProcess && !inProcess.timedOut
      ? inProcess
      : await runProcess({
          program: 'ps',
          args,
          timeoutMs: PROCESS_TABLE_QUERY_TIMEOUT_MS,
          maxOutputBytes: PROCESS_TABLE_MAX_BYTES
        })
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    throw new Error('PTY foreground group is unavailable')
  }
  return result.stdout
}

let ownRowCache: { pid: number; row: string } | null = null

/** Cache the own-TTY guard row to avoid a second ps fork on every SIGWINCH. */
async function readOwnProcessRow(currentPid: number): Promise<string> {
  if (ownRowCache?.pid !== currentPid) {
    // Failed reads remain retryable and yield no group.
    ownRowCache = { pid: currentPid, row: await runPs(currentPid) }
  }
  return ownRowCache.row
}

export function resetPosixPtyForegroundGroupOwnRowCache(): void {
  ownRowCache = null
}

/** macOS PID lists scan the whole table (~3.6s vs ~3ms for one PID), timing out into root-only delivery. */
async function readForegroundGroupTable(rootPid: number, currentPid: number): Promise<string> {
  return `${await runPs(rootPid)}\n${await readOwnProcessRow(currentPid)}`
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

/** Use tty tpgid to match kernel resize delivery; login(1), shells and foreground TUIs can occupy different groups. */
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
  // Pin the captured TTY so PID reuse cannot redirect a group signal.
  if (normalizeTty(root.tty) !== normalizeTty(ptsName)) {
    return null
  }
  // A dev daemon may share the PTY; never group-signal Orca itself.
  if (rows.some((row) => row.pid === currentPid && row.tty === root.tty)) {
    return null
  }
  // tpgid is -1 when no foreground group owns the tty, and pid 1 is never one.
  return root.tpgid > 1 ? root.tpgid : null
}

/** Fall back to scoped root delivery if group proof is unavailable.
 * Callers limit this to SIGWINCH; destructive signals require descendant identity checks. */
export async function signalPosixPtyForegroundGroup(
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
  let pgid: number | null
  try {
    pgid = getPosixPtyForegroundGroup(
      await (deps.readProcessTable ?? (() => readForegroundGroupTable(rootPid, currentPid)))(),
      rootPid,
      ptsName,
      currentPid
    )
  } catch {
    pgid = null
  }
  if (deps.ownsRoot && !deps.ownsRoot()) {
    return
  }
  if (pgid === null) {
    fallback()
    return
  }
  try {
    process.kill(-pgid, signal as NodeJS.Signals)
  } catch (error) {
    // The group can exit after ps; ESRCH is success because root fallback would be stale too.
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ESRCH') {
      fallback()
    }
  }
}
