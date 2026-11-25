import { readFile } from 'node:fs/promises'
import { isShellProcess } from '../../../shared/agent-status/process/shell-process-detection'
import {
  getCommandTokenPathBasename,
  getFirstCommandToken
} from '../../../shared/shell/command-resolution/command-token-scanner'
import { parseLinuxProcStatStartTime } from '../../../shared/process-observation/tables/process-table-snapshot-reader'
import { captureProcessTable } from '../../../shared/process-observation/tables/process-table-ps-capture'
import {
  ForegroundExitWatches,
  type ForegroundAgentIdentity
} from '../../pty/process-retirement/foreground-exit-watches'
import {
  isWindowsProcessStartTimeAvailable,
  readWindowsProcessCreationTime
} from '../../windows/windows-process-table'

/** Whether the process now at pid is still the agent a read named; checked once per new watch. */
export async function isSameForegroundAgent(
  pid: number,
  expected: ForegroundAgentIdentity
): Promise<boolean> {
  if (process.platform === 'win32') {
    // Windows recycles pids fast: a process created after the agent was identified is another process.
    // One process open; the lookup's census reads creation time through the same native call.
    const created = readWindowsProcessCreationTime(pid)
    if (created === null) {
      return false
    }
    // The lookup may have read a capture taken before the agent exited and its pid was reused.
    if (expected.creationTimeMs !== undefined) {
      return created === expected.creationTimeMs
    }
    return expected.identifiedAt !== undefined && created <= expected.identifiedAt
  }
  if (expected.startTime === undefined) {
    return false
  }
  // One process, in the same start marker the full capture recorded: /proc ticks on Linux, ps lstart elsewhere.
  const current =
    process.platform === 'linux' ? await readLinuxProcess(pid) : await readPsProcess(pid)
  return (
    current !== null &&
    normalizeSpaces(current.startTime) === normalizeSpaces(expected.startTime) &&
    // A shell-script launcher can `exec` a shell in the same pid, which no exit notice reports.
    !isShellProcess(current.program)
  )
}

async function readLinuxProcess(
  pid: number
): Promise<{ startTime: string; program: string } | null> {
  const [stat, cmdline] = await Promise.all([
    readFile(`/proc/${pid}/stat`, 'utf8'),
    readFile(`/proc/${pid}/cmdline`, 'utf8')
  ])
  const startTime = parseLinuxProcStatStartTime(stat)
  // argv[0], which for a script is its interpreter (stat's comm would name the script).
  const program = getCommandTokenPathBasename(cmdline.split('\0')[0] ?? '')
  return startTime === null ? null : { startTime, program }
}

async function readPsProcess(pid: number): Promise<{ startTime: string; program: string } | null> {
  const line = (await captureProcessTable(['-o', 'lstart=,command=', '-p', String(pid)])).trim()
  const match = /^(\S+\s+\S+\s+\d{1,2}\s+\S+\s+\d{4})\s+(.+)$/.exec(line)
  return match
    ? { startTime: match[1], program: getCommandTokenPathBasename(getFirstCommandToken(match[2])) }
    : null
}

function normalizeSpaces(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

export function createForegroundExitWatches(
  onAgentChange?: (sessionId: string) => void
): ForegroundExitWatches {
  return new ForegroundExitWatches(
    onAgentChange,
    isSameForegroundAgent,
    // Without creation times a Windows pid can't be confirmed, so arm nothing and keep the slow re-check.
    () => process.platform !== 'win32' || isWindowsProcessStartTimeAvailable()
  )
}
