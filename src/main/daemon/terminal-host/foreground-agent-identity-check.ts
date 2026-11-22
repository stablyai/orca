import { recognizeAgentProcess } from '../../../shared/agent-status/process/agent-process-recognition'
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
    // Windows recycles pids fast; the cached identity carries no creation time, so the name must still match.
    const row = (await readWindowsProcessIdentityTableFresh()).find((entry) => entry.pid === pid)
    const agent = recognizeAgentProcess(expected.processName)?.agent
    return (
      row !== undefined && agent !== undefined && recognizeAgentProcess(row.name)?.agent === agent
    )
  }
  const row = (await getFreshProcessTableSnapshot()).find((entry) => entry.pid === pid)
  return (
    row !== undefined && (expected.startTime === undefined || row.startTime === expected.startTime)
  )
}

export function createForegroundExitWatches(
  onAgentChange?: (sessionId: string) => void
): ForegroundExitWatches {
  return new ForegroundExitWatches(onAgentChange, isSameForegroundAgent)
}
