import { readFileSync } from 'node:fs'
import { hasControllingTty } from '../../shared/posix-controlling-terminal'
import { recordSelfInitiatedTreeKill } from '../crash-reporting/self-initiated-tree-kill-log'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { runProcess, runProcessSync } from '@orca/process-host'
import type { ProcessResult } from '@orca/process-host/process-spec'

const PROCESS_TABLE_TIMEOUT_MS = 1_000
const PROCESS_TABLE_MAX_BYTES = 1024 * 1024
const SELECTED_COLUMNS = 'pid=,pgid=,tty=,stat='
// Explicit widths prevent BusyBox from truncating device numbers into another terminal's identity.
const ALL_PROCESS_ARGS = [
  '-e',
  '-o',
  'pid=PROCESS_ID,pgid=PROCESS_GID,tty=TERMINAL_DEVICE_NUMBER,stat=PROCESS_STATE'
]
let psDialect: 'selected' | 'all' | undefined
let dialectProbe: Promise<void> | undefined

class UnsupportedPsSelectionError extends Error {}

export function resetPosixPtyProcessTableDialectForTests(): void {
  psDialect = undefined
  dialectProbe = undefined
}

type ProcessRow = {
  pid: number
  pgid: number
  tty: string
  state?: string
}

export type PosixPtyProcessGroupTerminationDeps = {
  platform?: NodeJS.Platform
  currentPid?: number
  readProcessTable?: () => string
  signalProcessGroup?: (pgid: number) => void
  /** Linux session id of a pid, or null when unreadable. */
  readProcessSessionId?: (pid: number) => number | null
}

/** Field 6 (`session`) of `/proc/<pid>/stat`, read past the parenthesised comm. */
export function parseLinuxProcStatSessionId(stat: string): number | null {
  const closingParen = stat.lastIndexOf(')')
  if (closingParen === -1) {
    return null
  }
  const session = Number(
    stat
      .slice(closingParen + 1)
      .trim()
      .split(/\s+/)[3]
  )
  return Number.isSafeInteger(session) && session > 0 ? session : null
}

function readLinuxProcessSessionId(pid: number): number | null {
  try {
    return parseLinuxProcStatSessionId(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return null
  }
}

function readProcessTableResult(result: ProcessResult): string {
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    throw new Error('PTY process table is unavailable')
  }
  return result.stdout
}

function readSelectionResult(result: ProcessResult, option: 'p' | 't'): string {
  const rejectedOption =
    /^ps: (?:invalid|illegal|unrecognized) option(?: -- |: | )['"]?-?([pt])['"]?\s*$/m.exec(
      result.stderr ?? ''
    )?.[1]
  if (
    result.code !== null &&
    result.code !== 0 &&
    !result.signal &&
    !result.timedOut &&
    !result.outputTruncated &&
    rejectedOption === option
  ) {
    throw new UnsupportedPsSelectionError()
  }
  const output = readProcessTableResult(result)
  if (psDialect === 'all') {
    throw new UnsupportedPsSelectionError()
  }
  return output
}

function* processTableQueries(rootPid: number): Generator<string[], string, ProcessResult> {
  if (psDialect !== 'all') {
    try {
      const root = readSelectionResult(yield ['-p', String(rootPid), '-o', SELECTED_COLUMNS], 'p')
      const rootRow = parseProcessRows(root).find((row) => row.pid === rootPid)
      if (!rootRow || !hasControllingTty(rootRow.tty)) {
        return root
      }
      const terminal = readSelectionResult(yield ['-t', rootRow.tty, '-o', SELECTED_COLUMNS], 't')
      psDialect ??= 'selected'
      return `${root}\n${terminal}`
    } catch (error) {
      if (!(error instanceof UnsupportedPsSelectionError)) {
        throw error
      }
      psDialect = 'all'
    }
  }
  return readProcessTableResult(yield ALL_PROCESS_ARGS)
}

function processTableSpec(args: string[]) {
  return {
    program: 'ps',
    args,
    env: { ...process.env, LC_ALL: 'C' },
    timeoutMs: PROCESS_TABLE_TIMEOUT_MS,
    maxOutputBytes: PROCESS_TABLE_MAX_BYTES
  }
}

function readPtyProcessTable(rootPid: number): string {
  const queries = processTableQueries(rootPid)
  let next = queries.next()
  while (!next.done) {
    next = queries.next(runProcessSync(processTableSpec(next.value)))
  }
  return next.value
}

export async function readPosixPtyProcessTable(
  rootPid: number,
  signal?: AbortSignal
): Promise<string> {
  while (dialectProbe) {
    await waitForPromiseWithSignal(dialectProbe, signal)
  }
  signal?.throwIfAborted()
  let releaseProbe: (() => void) | undefined
  if (psDialect === undefined) {
    dialectProbe = new Promise<void>((resolve) => {
      releaseProbe = resolve
    })
  }
  try {
    const queries = processTableQueries(rootPid)
    let next = queries.next()
    while (!next.done) {
      signal?.throwIfAborted()
      const result = await runProcess({ ...processTableSpec(next.value), signal })
      signal?.throwIfAborted()
      next = queries.next(result)
    }
    return next.value
  } finally {
    if (releaseProbe) {
      dialectProbe = undefined
      releaseProbe()
    }
  }
}

function parseProcessRows(output: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)(?:\s+(\S+))?/.exec(line)
    if (!match) {
      continue
    }
    const pid = Number(match[1])
    const pgid = Number(match[2])
    if (pid > 0 && pgid > 1) {
      rows.push({ pid, pgid, tty: match[3], state: match[4] })
    }
  }
  return rows
}

export function isPosixPtyRootStopped(output: string, rootPid: number): boolean {
  return (
    parseProcessRows(output)
      .find((row) => row.pid === rootPid)
      ?.state?.startsWith('T') === true
  )
}

export function getPosixPtyProcessGroups(
  output: string,
  rootPid: number,
  currentPid = process.pid,
  readSessionId?: (pid: number) => number | null
): number[] | null {
  const rows = parseProcessRows(output)
  const root = rows.find((row) => row.pid === rootPid)
  if (!root || !hasControllingTty(root.tty)) {
    return null
  }
  // A dev daemon may share the PTY; never group-signal Orca itself.
  if (rows.some((row) => row.pid === currentPid && row.tty === root.tty)) {
    return null
  }
  let members = rows.filter((row) => row.tty === root.tty)
  if (readSessionId) {
    // Container devpts numbers overlap: prove the root leads this session; setsid descendants no longer own its TTY (#16714).
    if (readSessionId(rootPid) !== rootPid) {
      return null
    }
    members = members.filter((row) => readSessionId(row.pid) === rootPid)
  }
  const groups = new Set(members.map((row) => row.pgid))
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
  const platform = deps.platform ?? process.platform
  if (platform === 'win32') {
    fallback()
    return
  }
  let groups: number[] | null
  try {
    groups = getPosixPtyProcessGroups(
      (deps.readProcessTable ?? (() => readPtyProcessTable(rootPid)))(),
      rootPid,
      deps.currentPid ?? process.pid,
      deps.readProcessSessionId ?? (platform === 'linux' ? readLinuxProcessSessionId : undefined)
    )
  } catch {
    groups = null
  }
  if (!groups || groups.length === 0) {
    fallback()
    return
  }
  if (signal === 'SIGSTOP') {
    // Stop the shell before its jobs so it cannot treat their suspension as completion.
    groups.unshift(...groups.splice(-1))
  }

  const signalProcessGroup =
    deps.signalProcessGroup ?? ((pgid: number) => process.kill(-pgid, signal))
  let firstError: unknown
  for (const pgid of groups) {
    try {
      signalProcessGroup(pgid)
    } catch (error) {
      if (signal === 'SIGSTOP' && pgid === groups[0]) {
        if (isProcessAlreadyGone(error)) {
          return
        }
        throw error
      }
      // Exit callbacks may reap captured groups before killpg; ESRCH already proves them gone.
      if (!isProcessAlreadyGone(error) && firstError === undefined) {
        firstError = error
      }
      continue
    }
    // Keep breadcrumbs outside the kill catch so diagnostic errors cannot be classified as signal failures.
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
