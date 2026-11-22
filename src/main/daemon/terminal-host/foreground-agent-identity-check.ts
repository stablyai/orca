import { getFreshProcessTableSnapshot } from '../../../shared/process-observation/tables/process-table-snapshot-reader'
import {
  ForegroundExitWatches,
  type ForegroundAgentIdentity
} from '../../pty/process-retirement/foreground-exit-watches'
import { readWindowsProcessIdentityTableFresh } from '../../windows/windows-process-table'

/** Whether the process now at pid is still the agent a read named; a fresh scan, once per new watch. */
export async function isSameForegroundAgent(
  pid: number,
  expected: ForegroundAgentIdentity
): Promise<boolean> {
  if (process.platform === 'win32') {
    // Windows recycles pids fast: a process created after the agent was identified is another process.
    const row = (await readWindowsProcessIdentityTableFresh()).find((entry) => entry.pid === pid)
    if (row?.creationTimeMs === undefined) {
      return false
    }
    // The lookup may have read a capture taken before the agent exited and its pid was reused.
    if (expected.creationTimeMs !== undefined) {
      return row.creationTimeMs === expected.creationTimeMs
    }
    return expected.identifiedAt !== undefined && row.creationTimeMs <= expected.identifiedAt
  }
  const row = (await getFreshProcessTableSnapshot()).find((entry) => entry.pid === pid)
  return row !== undefined && row.startTime !== undefined && row.startTime === expected.startTime
}

export function createForegroundExitWatches(
  onAgentChange?: (sessionId: string) => void
): ForegroundExitWatches {
  return new ForegroundExitWatches(onAgentChange, isSameForegroundAgent)
}
