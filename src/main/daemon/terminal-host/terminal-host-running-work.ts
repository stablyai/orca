import { isShellProcess } from '../../../shared/agent-status/process/shell-process-detection'
import { readTerminalProcessRows } from '../../pty/process-retirement/terminal-process-rows'
import type {
  HostProcessInspection,
  PtyRunningWorkObservation
} from '../../../shared/terminal/pty/lifecycle/terminal-process-inspection'

/** Check the specific terminal after a queued kill is admitted, even if the host-wide capture is shared. */
export async function recheckPosixTerminalIdle(
  inspection: HostProcessInspection
): Promise<PtyRunningWorkObservation> {
  const evidence = inspection.foregroundProcessEvidence
  if (evidence?.verdict === 'exited') {
    return 'idle'
  }
  if (evidence?.verdict !== 'live' || evidence.fence.platform !== 'posix') {
    return 'unverifiable'
  }
  const { shellPid, foregroundPgid } = evidence.fence
  const rows = await readTerminalProcessRows(shellPid)
  const root = rows?.find(({ pid }) => pid === shellPid)
  if (!root || root.tpgid !== foregroundPgid || !rows?.some(({ pid }) => pid === foregroundPgid)) {
    return 'unverifiable'
  }
  return rows.some(
    ({ pid, stat }) => pid !== shellPid && pid !== foregroundPgid && !stat.includes('Z')
  )
    ? 'running'
    : 'idle'
}

export function observedRunningWork(
  inspection: HostProcessInspection,
  incarnationId: string,
  stillCurrent: boolean,
  hasAgentOwner: (() => boolean) | undefined,
  commandActivity: 'running' | 'idle' | 'unknown' | 'input_since_capture'
): PtyRunningWorkObservation {
  const evidence = inspection.foregroundProcessEvidence
  if (evidence?.ptyIncarnationId !== incarnationId) {
    return 'unverifiable'
  }
  if (evidence.verdict === 'exited') {
    return 'idle'
  }
  if (!stillCurrent || !hasAgentOwner) {
    return 'unverifiable'
  }
  const foreground = inspection.foregroundProcess?.trim()
  if (
    hasAgentOwner() ||
    commandActivity === 'running' ||
    inspection.childProcessEvidence === 'children' ||
    (foreground && !isShellProcess(foreground))
  ) {
    return 'running'
  }
  return inspection.childProcessEvidence === 'no-children' &&
    commandActivity === 'idle' &&
    (evidence.verdict === 'live' || evidence.reason === 'windows_ssh_foreground_unavailable')
    ? 'idle'
    : 'unverifiable'
}
