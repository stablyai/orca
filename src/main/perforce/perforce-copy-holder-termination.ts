import { setTimeout as sleep } from 'node:timers/promises'
import type { HostProcess } from '../../shared/perforce/workspace-copy/workspace-copy-host'
import { readOrcaChromiumProcessPids } from '../orca-chromium-process-pids'
import {
  readWindowsProcessTableFresh,
  type WindowsProcessRow
} from '../windows/windows-process-table'

const EXIT_WAIT_MS = 5_000
const EXIT_POLL_MS = 150

function isSameProcess(row: WindowsProcessRow, target: HostProcess): boolean {
  return (
    row.pid === target.pid &&
    row.name === target.name &&
    row.command === target.commandLine &&
    (target.startedAt == null || row.creationTimeMs === target.startedAt)
  )
}

async function isRunning(target: HostProcess): Promise<boolean> {
  return (await readWindowsProcessTableFresh()).some((row) => isSameProcess(row, target))
}

/**
 * Ends a program holding a Perforce copy the user chose to delete, and waits for it to exit. Only
 * the exact process the user was shown: a reused pid, or Orca itself, is never ended.
 */
export async function endWorkspaceCopyHolder(target: HostProcess): Promise<boolean> {
  if (target.pid === process.pid || readOrcaChromiumProcessPids().has(target.pid)) {
    return false
  }
  if (!(await isRunning(target))) {
    return true
  }
  try {
    process.kill(target.pid)
  } catch {
    return false
  }
  for (const deadline = Date.now() + EXIT_WAIT_MS; Date.now() < deadline;) {
    await sleep(EXIT_POLL_MS)
    if (!(await isRunning(target))) {
      return true
    }
  }
  return false
}
