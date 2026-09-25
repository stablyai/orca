import { recordSelfInitiatedTreeKill } from '../crash-reporting/self-initiated-tree-kill-log'
import {
  runProcess,
  runProcessSync,
  type ProcessResult
} from '../../shared/child-process/run-process'

const PROCESS_TABLE_TIMEOUT_MS = 1_000
const PROCESS_TABLE_MAX_BYTES = 1024 * 1024

type ProcessRow = {
  pid: number
  pgid: number
  tty: string
}

export type PosixPtyProcessGroupTerminationDeps = {
  platform?: NodeJS.Platform
  currentPid?: number
  readProcessTable?: () => string
  signalProcessGroup?: (pgid: number) => void
}

function readProcessTableResult(result: ProcessResult): string {
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    throw new Error('PTY process table is unavailable')
  }
  return result.stdout
}

function runPs(args: string[]): string {
  return readProcessTableResult(
    runProcessSync({
      program: 'ps',
      args,
      timeoutMs: PROCESS_TABLE_TIMEOUT_MS,
      maxOutputBytes: PROCESS_TABLE_MAX_BYTES
    })
  )
}

function readPtyProcessTable(rootPid: number): string {
  const root = runPs(['-p', String(rootPid), '-o', 'pid=,pgid=,tty='])
  const rootRow = parseProcessRows(root).find((row) => row.pid === rootPid)
  if (!rootRow || rootRow.tty === '?' || rootRow.tty === '??') {
    return root
  }
  // Why: a whole-host `ps -ax` takes nearly a second on large machines. TTY
  // selection keeps forced terminal teardown proportional to one terminal.
  return `${root}\n${runPs(['-t', rootRow.tty, '-o', 'pid=,pgid=,tty='])}`
}

export async function readPosixPtyProcessTable(
  rootPid: number,
  signal?: AbortSignal
): Promise<string> {
  const read = async (args: string[]): Promise<string> => {
    const result = await runProcess({
      program: 'ps',
      args,
      timeoutMs: PROCESS_TABLE_TIMEOUT_MS,
      maxOutputBytes: PROCESS_TABLE_MAX_BYTES,
      signal
    })
    return readProcessTableResult(result)
  }
  const root = await read(['-p', String(rootPid), '-o', 'pid=,pgid=,tty='])
  const rootRow = parseProcessRows(root).find((row) => row.pid === rootPid)
  if (!rootRow || rootRow.tty === '?' || rootRow.tty === '??' || signal?.aborted) {
    return root
  }
  return `${root}\n${await read(['-t', rootRow.tty, '-o', 'pid=,pgid=,tty='])}`
}

function parseProcessRows(output: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line)
    if (!match) {
      continue
    }
    const pid = Number(match[1])
    const pgid = Number(match[2])
    if (pid > 0 && pgid > 1) {
      rows.push({ pid, pgid, tty: match[3] })
    }
  }
  return rows
}

export function getPosixPtyProcessGroups(
  output: string,
  rootPid: number,
  currentPid = process.pid
): number[] | null {
  const rows = parseProcessRows(output)
  const root = rows.find((row) => row.pid === rootPid)
  if (!root || root.tty === '?' || root.tty === '??') {
    return null
  }
  // Why: a development daemon can inherit its launch TTY. Never group-signal
  // when Orca itself shares the PTY; fall back to the already-scoped root kill.
  if (rows.some((row) => row.pid === currentPid && row.tty === root.tty)) {
    return null
  }
  const groups = new Set(rows.filter((row) => row.tty === root.tty).map((row) => row.pgid))
  if (!groups.has(root.pgid)) {
    return null
  }
  return [...groups].sort((left, right) => {
    if (left === root.pgid) {
      return 1
    }
    if (right === root.pgid) {
      return -1
    }
    return left - right
  })
}

function isProcessAlreadyGone(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ESRCH'
}

/** Force-kill every process group still attached to one POSIX PTY. */
export function forceKillPosixPtyProcessGroups(
  rootPid: number,
  fallback: () => void,
  deps: PosixPtyProcessGroupTerminationDeps = {}
): void {
  signalPosixPtyProcessGroups(rootPid, 'SIGKILL', fallback, deps)
}

/** Signal every process group proven to belong to one POSIX PTY. */
export function signalPosixPtyProcessGroups(
  rootPid: number,
  signal: NodeJS.Signals,
  fallback: () => void,
  deps: PosixPtyProcessGroupTerminationDeps = {}
): void {
  if ((deps.platform ?? process.platform) === 'win32') {
    fallback()
    return
  }
  let groups: number[] | null
  try {
    groups = getPosixPtyProcessGroups(
      (deps.readProcessTable ?? (() => readPtyProcessTable(rootPid)))(),
      rootPid,
      deps.currentPid ?? process.pid
    )
  } catch {
    groups = null
  }
  if (!groups || groups.length === 0) {
    fallback()
    return
  }

  const signalProcessGroup =
    deps.signalProcessGroup ?? ((pgid: number) => process.kill(-pgid, signal))
  let firstError: unknown
  for (const pgid of groups) {
    try {
      signalProcessGroup(pgid)
    } catch (error) {
      // Why: the PTY exit callback may reap a group between `ps` and killpg.
      // ESRCH is proof that this captured owner is already gone, not failure.
      if (!isProcessAlreadyGone(error) && firstError === undefined) {
        firstError = error
      }
      continue
    }
    // Outside the try: this catch is the ESRCH contract, and a throw from the
    // breadcrumb path would be rethrown as a failed kill.
    if (signal === 'SIGKILL') {
      recordSelfInitiatedTreeKill({
        pid: pgid,
        site: 'posix-pty-process-group-sweep',
        scope: 'posix-process-group'
      })
    }
  }
  if (firstError !== undefined) {
    throw firstError
  }
}
