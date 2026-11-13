import { open, readFile, readlink } from 'node:fs/promises'
import { readLibprocProcessArgv } from '../../../shared/libproc-addon'
import { observedAgentInputMode } from '../../../shared/agent-status/process/agent-process-input-mode'
import { recognizeAgentProcessFromCommandLine } from '../../../shared/agent-status/process/agent-process-recognition'
import {
  getCommandTokenPathBasename,
  getFirstCommandToken
} from '../../../shared/command-token-scanner'
import { isShellProcess } from '../../../shared/agent-status/process/shell-process-detection'
import type { ProcessTableRow } from '../../../shared/process-table-snapshot'
import {
  beforeDeadline,
  DEADLINE_PASSED,
  monotonicNow
} from '../../../shared/deadline-settle-notifier'

const MAX_ARGV_BYTES = 1024 * 1024
let outstandingLinuxArgvReads = 0
type LinuxExecution = { pgid: number; tpgid: number; start: string; comm: string }

function linuxExecution(stat: string): LinuxExecution | null {
  const end = stat.lastIndexOf(')')
  const start = stat.indexOf('(')
  if (start === -1 || end <= start) {
    return null
  }
  const fields = stat
    .slice(end + 1)
    .trim()
    .split(/\s+/)
  const pgid = Number(fields[2])
  const tpgid = Number(fields[5])
  return Number.isSafeInteger(pgid) && Number.isSafeInteger(tpgid) && /^\d+$/.test(fields[19] ?? '')
    ? { pgid, tpgid, start: fields[19], comm: stat.slice(start + 1, end) }
    : null
}

async function linuxArgv(
  pid: number,
  group: number
): Promise<{ executable: string; argv: string[] } | null> {
  const statPath = `/proc/${pid}/stat`
  const before = linuxExecution(await readFile(statPath, 'utf8'))
  if (!before || before.pgid !== group || before.tpgid !== group) {
    return null
  }
  const file = await open(`/proc/${pid}/cmdline`, 'r')
  let bytes: Buffer
  try {
    const buffer = Buffer.alloc(MAX_ARGV_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const read = await file.read(buffer, length, buffer.length - length, length)
      if (!read.bytesRead) {
        break
      }
      length += read.bytesRead
    }
    if (!length || length > MAX_ARGV_BYTES || buffer[length - 1] !== 0) {
      return null
    }
    bytes = buffer.subarray(0, length - 1)
  } finally {
    await file.close()
  }
  const executable = await readlink(`/proc/${pid}/exe`)
  const after = linuxExecution(await readFile(statPath, 'utf8'))
  if (
    !after ||
    before.start !== after.start ||
    before.comm !== after.comm ||
    after.pgid !== group ||
    after.tpgid !== group
  ) {
    return null
  }
  return { executable, argv: bytes.toString('utf8').split('\0') }
}

/** Enrich one unambiguous foreground recipient inside its existing shared observation. */
export async function foregroundProcessInputMode(
  rows: readonly ProcessTableRow[],
  group: number,
  deadlineMs: number
): Promise<'noninteractive' | undefined> {
  const candidates = rows.filter(
    (row) =>
      row.pgid === group &&
      !/[TZ]/.test(row.stat) &&
      (!isShellProcess(getCommandTokenPathBasename(getFirstCommandToken(row.command))) ||
        recognizeAgentProcessFromCommandLine(row.command, { includeHeadlessOneShot: true }) !==
          null)
  )
  if (candidates.length !== 1 || Date.now() >= deadlineMs) {
    return undefined
  }
  const candidate = candidates[0]
  const confirmedClaude =
    recognizeAgentProcessFromCommandLine(candidate.command, { includeHeadlessOneShot: true })
      ?.agent === 'claude'
  // Identity text may select an enrichment; only the exact host argv below can establish mode.
  if (!confirmedClaude) {
    return undefined
  }
  try {
    const remaining = Math.max(0, deadlineMs - Date.now())
    let read: Promise<{ executable: string; argv: string[] } | null> | null = null
    if (process.platform === 'darwin') {
      read = readLibprocProcessArgv(candidate.pid, group, remaining)
    } else if (process.platform === 'linux' && outstandingLinuxArgvReads < 2) {
      outstandingLinuxArgvReads++
      read = linuxArgv(candidate.pid, group).finally(() => {
        outstandingLinuxArgvReads--
      })
    }
    if (!read) {
      return undefined
    }
    const sample = await beforeDeadline(read, monotonicNow() + remaining)
    return sample === DEADLINE_PASSED || !sample
      ? undefined
      : observedAgentInputMode(sample.executable, sample.argv, confirmedClaude)
  } catch {
    return undefined
  }
}
