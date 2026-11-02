import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { hasControllingTty } from '../../shared/posix-controlling-terminal'
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

export function readLinuxProcessSessionId(pid: number): number | null {
  try {
    return parseLinuxProcStatSessionId(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return null
  }
}

export async function readLinuxProcessSessionIdAsync(pid: number): Promise<number | null> {
  try {
    return parseLinuxProcStatSessionId(await readFile(`/proc/${pid}/stat`, 'utf8'))
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

export function readPosixPtyProcessTableSync(rootPid: number): string {
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
  // Wait out one probe only: chaining behind each failed probe would stack their timeouts.
  if (dialectProbe) {
    await waitForPromiseWithSignal(dialectProbe, signal)
  }
  signal?.throwIfAborted()
  let releaseProbe: (() => void) | undefined
  if (psDialect === undefined && !dialectProbe) {
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

export function parseProcessRows(output: string): ProcessRow[] {
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
