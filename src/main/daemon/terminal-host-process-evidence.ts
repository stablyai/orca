import { isShellProcess } from '../../shared/agent-detection'
import type { PtyChildProcessesEvidence } from '../../shared/pty-process-inspection-evidence'
import type { PtyProcessInspection } from '../providers/pty-process-inspection'
import type { ForegroundProcessObservation } from './session-subprocess-handle'

/**
 * Wire result for the daemon 'inspectProcess' request. The legacy fields keep
 * the exact pre-evidence collapse (a degraded read still publishes the shell
 * title it fell back to); only the optional `processEvidence` distinguishes
 * "observed idle" from "could not ask", so a degraded read is never exit
 * evidence (docs/reference/ssh-execution-boundary.md). The field is additive:
 * older app clients ignore it and see byte-identical content.
 */
export function buildDaemonInspectProcessResult(
  observation: ForegroundProcessObservation
): PtyProcessInspection {
  const foregroundProcess = observation.processName
  return {
    foregroundProcess,
    hasChildProcesses: foregroundProcess !== null && !isShellProcess(foregroundProcess),
    processEvidence: {
      foreground: observation.evidence,
      children: deriveChildProcessesEvidence(observation)
    }
  }
}

/** A daemon pane's only child signal IS the foreground observation, so the
 *  children verdict can never outrank the foreground's. Observed null means
 *  the host itself watched the pane die — positive absence, not a failure. */
function deriveChildProcessesEvidence(
  observation: ForegroundProcessObservation
): PtyChildProcessesEvidence {
  if (observation.evidence.verdict !== 'observed') {
    return { verdict: 'unverifiable', reason: observation.evidence.reason }
  }
  const processName = observation.evidence.processName
  if (processName !== null && !isShellProcess(processName)) {
    return { verdict: 'live' }
  }
  return { verdict: 'exited' }
}
