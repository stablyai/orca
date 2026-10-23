import { statSync } from 'node:fs'
import { runProcessSync, type ProcessResult } from '../../shared/child-process/run-process'

const PROCESS_TABLE_TIMEOUT_MS = 1_000
const PROCESS_TABLE_MAX_BYTES = 1024 * 1024
// Explicit widths keep BusyBox from merging device numbers into the next column.
export const POSIX_PS_ALL_PROCESS_ARGS = [
  '-e',
  '-o',
  'pid=PROCESS_ID,pgid=PROCESS_GID,tty=TERMINAL_DEVICE_NUMBER,stat=PROCESS_STATE'
]

let terminalSelectionUnsupported = false

export function resetPosixTerminalSelectionForTests(): void {
  terminalSelectionUnsupported = false
}

export function posixProcessTableSpec(args: string[]) {
  return {
    program: 'ps',
    args,
    env: { ...process.env, LC_ALL: 'C' },
    timeoutMs: PROCESS_TABLE_TIMEOUT_MS,
    maxOutputBytes: PROCESS_TABLE_MAX_BYTES
  }
}

export function readPosixProcessTableOutput(result: ProcessResult): string {
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    throw new Error('PTY process table is unavailable')
  }
  return result.stdout
}

export function rejectedPosixPsSelector(result: ProcessResult): 'p' | 't' | null {
  const rejectedOption =
    /^ps: (?:invalid|illegal|unrecognized) option(?: -- |: | )['"]?-?([pt])['"]?\s*$/m.exec(
      result.stderr ?? ''
    )?.[1]
  if (
    result.code === null ||
    result.code === 0 ||
    result.signal ||
    result.timedOut ||
    result.outputTruncated ||
    (rejectedOption !== 'p' && rejectedOption !== 't')
  ) {
    return null
  }
  return rejectedOption
}

function isSafeTerminalName(ptsName: string): boolean {
  return /^[\w./]{1,128}$/.test(ptsName) && !ptsName.startsWith('-')
}

function parseProcessGroupIds(output: string): number[] {
  const groups = new Set<number>()
  for (const line of output.split(/\r?\n/)) {
    const pgid = Number(line.trim())
    if (Number.isInteger(pgid) && pgid > 1) {
      groups.add(pgid)
    }
  }
  return [...groups]
}

/** BusyBox prints st_rdev with glibc's major,minor split, not the path. */
export function posixBusyboxTtyName(rdev: number): string | null {
  if (!Number.isSafeInteger(rdev) || rdev < 0) {
    return null
  }
  const dev = BigInt(rdev)
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn)
  const minor = (dev & 0xffn) | ((dev >> 12n) & ~0xffn)
  return `${major},${minor}`
}

function characterDeviceNumber(ptsName: string): number | null {
  try {
    const stats = statSync(ptsName)
    return stats.isCharacterDevice() ? stats.rdev : null
  } catch {
    return null
  }
}

function terminalNames(ptsName: string, rdev: number | null): Set<string> {
  const names = new Set<string>([ptsName])
  const base = ptsName.slice(ptsName.lastIndexOf('/') + 1)
  if (base) {
    names.add(base)
  }
  // procps prints the path under /dev, so /dev/pts/100 is pts/100, not 100.
  if (ptsName.startsWith('/dev/')) {
    const relative = ptsName.slice('/dev/'.length)
    if (relative) {
      names.add(relative)
    }
  }
  const deviceName = rdev === null ? null : posixBusyboxTtyName(rdev)
  if (deviceName) {
    names.add(deviceName)
  }
  return names
}

function groupsFromFullTable(ptsName: string, rdev: number | null): string {
  const table = readPosixProcessTableOutput(
    runProcessSync(posixProcessTableSpec(POSIX_PS_ALL_PROCESS_ARGS))
  )
  const names = terminalNames(ptsName, rdev)
  const groups: number[] = []
  for (const line of table.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line)
    if (!match || !names.has(match[3])) {
      continue
    }
    const pgid = Number(match[2])
    if (pgid > 1) {
      groups.push(pgid)
    }
  }
  return groups.join('\n')
}

function readGroupsOnTerminal(
  ptsName: string,
  readDeviceNumber: (ptsName: string) => number | null
): string {
  if (terminalSelectionUnsupported) {
    return groupsFromFullTable(ptsName, readDeviceNumber(ptsName))
  }
  const selected = runProcessSync(posixProcessTableSpec(['-t', ptsName, '-o', 'pgid=']))
  if (rejectedPosixPsSelector(selected) !== 't') {
    return readPosixProcessTableOutput(selected)
  }
  terminalSelectionUnsupported = true
  return groupsFromFullTable(ptsName, readDeviceNumber(ptsName))
}

/** Groups still attached to this PTY. `null` means the table could not be read. */
export function readPosixProcessGroupsOnTerminal(
  ptsName: string,
  deps: {
    readProcessTable?: (ptsName: string) => string
    characterDeviceNumber?: (ptsName: string) => number | null
  } = {}
): number[] | null {
  if (!isSafeTerminalName(ptsName)) {
    return null
  }
  try {
    const output = deps.readProcessTable
      ? deps.readProcessTable(ptsName)
      : readGroupsOnTerminal(ptsName, deps.characterDeviceNumber ?? characterDeviceNumber)
    return parseProcessGroupIds(output)
  } catch {
    return null
  }
}
