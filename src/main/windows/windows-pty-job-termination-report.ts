import type { IPty } from 'node-pty'
import { readWindowsPtyJobProcessIds } from '../providers/windows-pty-job-membership'
import {
  isWindowsProcessStartTimeAvailable,
  readWindowsProcessIdentityTableFresh,
  type WindowsProcessIdentityRow
} from './windows-process-table'
import { terminatePtyJob, type JobTerminationOutcome } from './windows-pty-job'

export type PtyJobProcessIdentity = { pid: number; startTime: string }

/** `terminated` is reported only when the job itself was ended, so every member is gone. */
export type PtyJobTerminationReport =
  | { terminated: true; identities: PtyJobProcessIdentity[] }
  | { terminated: false }

type Deps = {
  platform: NodeJS.Platform
  startTimeAvailable: () => boolean
  readTable: () => Promise<WindowsProcessIdentityRow[]>
  readMembers: (proc: IPty) => ReadonlySet<number> | null
  terminate: (proc: IPty) => JobTerminationOutcome
}

const defaultDeps: Deps = {
  platform: process.platform,
  startTimeAvailable: isWindowsProcessStartTimeAvailable,
  readTable: readWindowsProcessIdentityTableFresh,
  readMembers: (proc) => readWindowsPtyJobProcessIds(proc),
  terminate: terminatePtyJob
}

const NOT_TERMINATED: PtyJobTerminationReport = { terminated: false }
const READ_ATTEMPTS = 3

export function windowsProcessStartTime(creationTimeMs: number): string {
  return String(creationTimeMs)
}

/** Records every job member, then ends the job; WSL guests are invisible to the job, so they refuse. */
export async function terminatePtyJobAndReport(
  proc: IPty,
  options: { wslDistro: string | null },
  deps: Deps = defaultDeps
): Promise<PtyJobTerminationReport> {
  if (deps.platform !== 'win32' || options.wslDistro || !deps.startTimeAvailable()) {
    return NOT_TERMINATED
  }
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    // Why: table first, so a member that exits before the membership read simply drops out.
    const table = await deps.readTable().catch(() => null)
    const members = deps.readMembers(proc)
    if (!table || !members) {
      return NOT_TERMINATED
    }
    const byPid = new Map(table.map((row) => [row.pid, row]))
    const rows = [...members].map((pid) => byPid.get(pid))
    if (rows.some((row) => row?.name.toLowerCase() === 'wsl.exe')) {
      return NOT_TERMINATED
    }
    const identities: PtyJobProcessIdentity[] = []
    for (const row of rows) {
      if (row?.creationTimeMs === undefined) {
        break
      }
      identities.push({ pid: row.pid, startTime: windowsProcessStartTime(row.creationTimeMs) })
    }
    if (identities.length !== rows.length) {
      // A member started after the table read; read both again.
      continue
    }
    return deps.terminate(proc) === 'terminated'
      ? { terminated: true, identities }
      : NOT_TERMINATED
  }
  return NOT_TERMINATED
}
