import { pruneRetiredPtyIncarnations } from '../../../shared/terminal/pty/lifecycle/retired-pty-incarnations'
import type { RemoteForegroundEvidence } from '../../../shared/terminal/pty/foreground/foreground-process-evidence'
import type { PtyProcessInspectionOptions } from '../../providers/pty/process-inspection'
import type { ForegroundExitWatches } from '../../pty/process-retirement/foreground-exit-watches'
import type { Session } from '../sessions/session'
import { getInspectableTerminalHostSession } from './terminal-host-session-access'
import {
  inspectTerminalHostProcess,
  type RetiredIncarnation,
  type TerminalHostProcessInspection
} from './terminal-host-process-inspection'

export function inspectTerminalHostSession(
  sessions: ReadonlyMap<string, Session>,
  retired: Map<string, RetiredIncarnation>,
  sessionId: string,
  options: PtyProcessInspectionOptions | undefined,
  authorityGeneration: string,
  nextObservationEpoch: () => number,
  foregroundExitWatches?: ForegroundExitWatches
): Promise<TerminalHostProcessInspection> {
  pruneRetiredPtyIncarnations(retired)
  const session = getInspectableTerminalHostSession(
    sessions,
    retired,
    sessionId,
    options?.expectedIncarnationId
  )
  return inspectTerminalHostProcess({
    sessionId,
    currentSession: () => sessions.get(sessionId),
    session: session?.isAlive ? session : null,
    ...options,
    retiredIncarnation: retired.get(sessionId),
    authorityGeneration,
    nextObservationEpoch
  }).then((result) =>
    foregroundExitWatches?.noteInspection(
      sessionId,
      sessions.get(sessionId),
      result.foregroundProcess,
      provenForegroundPid(result.foregroundProcessEvidence)
    )
      ? { ...result, foregroundExitWatched: true as const }
      : result
  )
}

/** The process a full POSIX read proved in the foreground: the agent, else a command group other than the shell. */
function provenForegroundPid(evidence: RemoteForegroundEvidence | undefined): number | undefined {
  if (evidence?.verdict !== 'live' || evidence.fence.platform !== 'posix') {
    return undefined
  }
  const { fence } = evidence
  if (evidence.processName !== null) {
    return fence.process?.pid
  }
  return fence.foregroundPgid === fence.shellPid ? undefined : fence.foregroundPgid
}
