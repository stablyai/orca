import { execFileSync } from 'node:child_process'

const PROCESS_TABLE_TIMEOUT_MS = 1_000
const PROCESS_TABLE_MAX_BYTES = 1024 * 1024

type ProcessRow = {
  pid: number
  tty: string
}

export type PosixPtySessionLiveness = 'live' | 'empty' | 'gone' | 'unknown'

export type PosixPtySessionLivenessDeps = {
  platform?: NodeJS.Platform
  currentPid?: number
  readProcessTable?: (rootPid: number) => string
}

function runPs(args: string[]): string {
  return execFileSync('ps', args, {
    encoding: 'utf8',
    timeout: PROCESS_TABLE_TIMEOUT_MS,
    maxBuffer: PROCESS_TABLE_MAX_BYTES
  })
}

function readPtyProcessTable(rootPid: number): string {
  const root = runPs(['-p', String(rootPid), '-o', 'pid=,tty='])
  const rootRow = parseProcessRows(root).find((row) => row.pid === rootPid)
  if (!rootRow || rootRow.tty === '?' || rootRow.tty === '??') {
    return root
  }
  // Why: TTY-scoped ps stays proportional to one terminal; whole-host scans blow teardown budgets.
  return `${root}\n${runPs(['-t', rootRow.tty, '-o', 'pid=,tty='])}`
}

function parseProcessRows(output: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\S+)/.exec(line)
    if (!match) {
      continue
    }
    const pid = Number(match[1])
    if (pid > 0) {
      rows.push({ pid, tty: match[2] })
    }
  }
  return rows
}

/**
 * Classifies whether a POSIX PTY root still hosts real session work.
 *
 * On macOS TCC-wrapped spawns the root is `login(1)`. When the inner shell exits
 * without `login` exiting, the daemon never gets `onExit` and the PTY leaks
 * (#13764). `empty` means the root is alive on a real TTY with no other
 * processes sharing that TTY — safe to force-kill the known root so normal
 * exit/reap runs. `unknown` never authorizes a kill.
 */
export function classifyPosixPtySessionLiveness(
  output: string,
  rootPid: number,
  currentPid = process.pid
): PosixPtySessionLiveness {
  const rows = parseProcessRows(output)
  const root = rows.find((row) => row.pid === rootPid)
  if (!root) {
    return 'gone'
  }
  if (root.tty === '?' || root.tty === '??') {
    return 'unknown'
  }
  // Why: a development daemon can inherit its launch TTY; never treat that as an empty session.
  if (rows.some((row) => row.pid === currentPid && row.tty === root.tty)) {
    return 'unknown'
  }
  const peers = rows.filter((row) => row.tty === root.tty && row.pid !== rootPid)
  return peers.length === 0 ? 'empty' : 'live'
}

export function readPosixPtySessionLiveness(
  rootPid: number,
  deps: PosixPtySessionLivenessDeps = {}
): PosixPtySessionLiveness {
  if ((deps.platform ?? process.platform) === 'win32') {
    return 'unknown'
  }
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) {
    return 'unknown'
  }
  try {
    const table = (deps.readProcessTable ?? readPtyProcessTable)(rootPid)
    return classifyPosixPtySessionLiveness(table, rootPid, deps.currentPid ?? process.pid)
  } catch {
    return 'unknown'
  }
}
