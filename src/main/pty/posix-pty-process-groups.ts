import { hasControllingTty } from '../../shared/posix-controlling-terminal'
import { recordSelfInitiatedTreeKill } from '../crash-reporting/self-initiated-tree-kill-log'
import {
  POSIX_PS_ALL_PROCESS_ARGS,
  posixProcessTableSpec,
  readPosixProcessTableOutput,
  rejectedPosixPsSelector,
  resetPosixTerminalSelectionForTests
} from './posix-process-groups-on-terminal'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { runProcess, runProcessSync } from '@orca/process-host'
import type { ProcessResult } from '@orca/process-host/process-spec'

const SELECTED_COLUMNS = 'pid=,pgid=,tty=,stat='
let psDialect: 'selected' | 'all' | undefined
let dialectProbe: Promise<void> | undefined

class UnsupportedPsSelectionError extends Error {}

export function resetPosixPtyProcessTableDialectForTests(): void {
  psDialect = undefined
  dialectProbe = undefined
  resetPosixTerminalSelectionForTests()
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
}

function readSelectionResult(result: ProcessResult, option: 'p' | 't'): string {
  if (rejectedPosixPsSelector(result) === option) {
    throw new UnsupportedPsSelectionError()
  }
  const output = readPosixProcessTableOutput(result)
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
  return readPosixProcessTableOutput(yield POSIX_PS_ALL_PROCESS_ARGS)
}

function readPtyProcessTable(rootPid: number): string {
  const queries = processTableQueries(rootPid)
  let next = queries.next()
  while (!next.done) {
    next = queries.next(runProcessSync(posixProcessTableSpec(next.value)))
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
      const result = await runProcess({ ...posixProcessTableSpec(next.value), signal })
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
  currentPid = process.pid
): number[] | null {
  const rows = parseProcessRows(output)
  const root = rows.find((row) => row.pid === rootPid)
  if (!root || !hasControllingTty(root.tty)) {
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

export { readPosixProcessGroupsOnTerminal } from './posix-process-groups-on-terminal'

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
