import { isShellProcess } from '../../../shared/agent-status/process/shell-process-detection'
import type {
  HostProcessInspection,
  PtyRunningWorkObservation
} from '../../../shared/terminal/pty/lifecycle/terminal-process-inspection'

export function observedRunningWork(
  inspection: HostProcessInspection,
  incarnationId: string,
  stillCurrent: boolean,
  hasAgentOwner: (() => boolean) | undefined
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
    inspection.childProcessEvidence === 'children' ||
    (foreground && !isShellProcess(foreground))
  ) {
    return 'running'
  }
  return inspection.childProcessEvidence === 'no-children' &&
    (evidence.verdict === 'live' || evidence.reason === 'windows_ssh_foreground_unavailable')
    ? 'idle'
    : 'unverifiable'
}
