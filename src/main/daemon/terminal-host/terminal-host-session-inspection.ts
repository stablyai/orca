import { pruneRetiredPtyIncarnations } from '../../../shared/terminal/pty/lifecycle/retired-pty-incarnations'
import type { RemoteForegroundEvidence } from '../../../shared/terminal/pty/foreground/foreground-process-evidence'
import type { ClaimedAgentPtyOwnerRegistry } from '../../../shared/agent-session/lifecycle/leases/claimed-agent-pty-owner'
import { observedRunningWork } from './terminal-host-running-work'
import type { ForegroundExitWatches } from '../../pty/process-retirement/foreground-exit-watches'
import type { Session } from '../sessions/session'
import { getInspectableTerminalHostSession } from './terminal-host-session-access'
import {
  inspectTerminalHostProcess,
  type RetiredIncarnation,
  type TerminalHostProcessInspection,
  type TerminalHostProcessInspectionOptions
} from './terminal-host-process-inspection'

export function inspectTerminalHostSession(
  sessions: ReadonlyMap<string, Session>,
  retired: Map<string, RetiredIncarnation>,
  sessionId: string,
  options: TerminalHostProcessInspectionOptions | undefined,
  authorityGeneration: string,
  nextObservationEpoch: () => number,
  foregroundExitWatches?: ForegroundExitWatches,
  owners?: ClaimedAgentPtyOwnerRegistry
): Promise<TerminalHostProcessInspection> {
  const incarnationId = options?.expectedIncarnationId
  const runningWorkSinceMs = options?.runningWorkSinceMs
  if (runningWorkSinceMs === undefined) {
    pruneRetiredPtyIncarnations(retired)
  }
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
  }).then((result) => {
    if (runningWorkSinceMs !== undefined && incarnationId) {
      return {
        ...result,
        runningWork: observedRunningWork(
          result,
          incarnationId,
          session?.isAlive === true && sessions.get(sessionId) === session,
          owners ? () => owners.listForPty(sessionId).length > 0 : undefined,
          session?.getCommandActivity(runningWorkSinceMs) ?? 'unknown'
        )
      }
    }
    const evidence = result.foregroundProcessEvidence
    const proven = provenAgentProcess(evidence)
    return foregroundExitWatches?.noteInspection(
      sessionId,
      sessions.get(sessionId),
      result.foregroundProcess,
      proven?.pid,
      proven?.startTime,
      // Cheap anchored reads carry no evidence because the pane fingerprint still matches the full capture.
      evidence === undefined || evidence.verdict === 'live' || process.platform === 'win32'
    )
      ? { ...result, foregroundExitWatched: true as const }
      : result
  })
}

function provenAgentProcess(
  evidence: RemoteForegroundEvidence | undefined
): { pid: number; startTime: string } | undefined {
  return evidence?.verdict === 'live' && evidence.fence.platform === 'posix'
    ? evidence.fence.process
    : undefined
}
