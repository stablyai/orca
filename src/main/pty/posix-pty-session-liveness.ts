import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const PROCESS_TABLE_TIMEOUT_MS = 1_000
const PROCESS_TABLE_MAX_BYTES = 1024 * 1024

type ProcessRow = {
  pid: number
  ppid: number
  tty: string
  command: string
}

export type PosixPtySessionLiveness = 'live' | 'empty' | 'gone' | 'unknown'

/** One TTY-scoped process-table sample for a PTY root. */
export type PosixPtyRootSnapshot = {
  liveness: PosixPtySessionLiveness
  rootPid: number
  ppid: number | null
  tty: string | null
  command: string | null
}

export type PosixPtySessionLivenessDeps = {
  platform?: NodeJS.Platform
  currentPid?: number
  /** Injectable async process-table read; production uses bounded `ps`. */
  readProcessTable?: (rootPid: number) => Promise<string>
}

async function runPs(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('ps', args, {
    encoding: 'utf8',
    timeout: PROCESS_TABLE_TIMEOUT_MS,
    maxBuffer: PROCESS_TABLE_MAX_BYTES
  })
  return stdout
}

async function readPtyProcessTable(rootPid: number): Promise<string> {
  const root = await runPs(['-p', String(rootPid), '-o', 'pid=,ppid=,tty=,command='])
  const rootRow = parseProcessRows(root).find((row) => row.pid === rootPid)
  if (!rootRow || rootRow.tty === '?' || rootRow.tty === '??') {
    return root
  }
  // Why: TTY-scoped ps stays proportional to one terminal; whole-host scans blow daemon budgets.
  const peers = await runPs(['-t', rootRow.tty, '-o', 'pid=,ppid=,tty=,command='])
  return `${root}\n${peers}`
}

function parseProcessRows(output: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!match) {
      continue
    }
    const pid = Number(match[1])
    const ppid = Number(match[2])
    if (pid > 0 && Number.isFinite(ppid)) {
      rows.push({ pid, ppid, tty: match[3], command: match[4].trim() })
    }
  }
  return rows
}

/** True when argv0 is macOS login(1) (TCC wrapper), not an unrelated binary name. */
export function isMacosLoginWrapperCommand(command: string): boolean {
  const argv0 = command.trim().split(/\s+/)[0] ?? ''
  return argv0 === 'login' || argv0 === '/usr/bin/login' || argv0.endsWith('/login')
}

/**
 * Classifies whether a POSIX PTY root still hosts real session work.
 *
 * `empty` = root alive on a real TTY with no peers. `unknown` never authorizes a kill.
 */
export function classifyPosixPtySessionLiveness(
  output: string,
  rootPid: number,
  currentPid = process.pid
): PosixPtySessionLiveness {
  return buildPosixPtyRootSnapshot(output, rootPid, currentPid).liveness
}

export function buildPosixPtyRootSnapshot(
  output: string,
  rootPid: number,
  currentPid = process.pid
): PosixPtyRootSnapshot {
  const rows = parseProcessRows(output)
  const root = rows.find((row) => row.pid === rootPid)
  if (!root) {
    return { liveness: 'gone', rootPid, ppid: null, tty: null, command: null }
  }
  if (root.tty === '?' || root.tty === '??') {
    return {
      liveness: 'unknown',
      rootPid,
      ppid: root.ppid,
      tty: root.tty,
      command: root.command || null
    }
  }
  // Why: a development daemon can inherit its launch TTY; never treat that as empty.
  if (rows.some((row) => row.pid === currentPid && row.tty === root.tty)) {
    return {
      liveness: 'unknown',
      rootPid,
      ppid: root.ppid,
      tty: root.tty,
      command: root.command || null
    }
  }
  const peers = rows.filter((row) => row.tty === root.tty && row.pid !== rootPid)
  return {
    liveness: peers.length === 0 ? 'empty' : 'live',
    rootPid,
    ppid: root.ppid,
    tty: root.tty,
    command: root.command || null
  }
}

/**
 * Final pre-signal gate: empty TTY, still our direct child, still login(1).
 * Why: a generic pgroup sweep can kill a peer that appeared after the empty poll;
 * PID reuse must not let us SIGKILL an unrelated process.
 */
export function provesOwnedEmptyLoginWrapper(
  snapshot: PosixPtyRootSnapshot,
  expected: { rootPid: number; ownerPid: number }
): boolean {
  if (snapshot.liveness !== 'empty') {
    return false
  }
  if (snapshot.rootPid !== expected.rootPid) {
    return false
  }
  if (snapshot.ppid !== expected.ownerPid) {
    return false
  }
  if (!snapshot.command || !isMacosLoginWrapperCommand(snapshot.command)) {
    return false
  }
  return true
}

/** Async bounded process-table probe. Timeouts/parse failures fail closed as `unknown`. */
export async function readPosixPtyRootSnapshot(
  rootPid: number,
  deps: PosixPtySessionLivenessDeps = {}
): Promise<PosixPtyRootSnapshot> {
  if ((deps.platform ?? process.platform) === 'win32') {
    return { liveness: 'unknown', rootPid, ppid: null, tty: null, command: null }
  }
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) {
    return { liveness: 'unknown', rootPid, ppid: null, tty: null, command: null }
  }
  try {
    const table = await (deps.readProcessTable ?? readPtyProcessTable)(rootPid)
    if (typeof table !== 'string') {
      return { liveness: 'unknown', rootPid, ppid: null, tty: null, command: null }
    }
    return buildPosixPtyRootSnapshot(table, rootPid, deps.currentPid ?? process.pid)
  } catch {
    return { liveness: 'unknown', rootPid, ppid: null, tty: null, command: null }
  }
}

export async function readPosixPtySessionLiveness(
  rootPid: number,
  deps: PosixPtySessionLivenessDeps = {}
): Promise<PosixPtySessionLiveness> {
  return (await readPosixPtyRootSnapshot(rootPid, deps)).liveness
}
