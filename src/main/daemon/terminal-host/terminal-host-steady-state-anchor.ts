import { recognizeAgentProcess } from '../../../shared/agent-status/process/agent-process-recognition'
import type { RemoteForegroundEvidence } from '../../../shared/terminal/pty/foreground/foreground-process-evidence'
import type { Session } from '../sessions/session'
import { readForegroundGroupIdentity } from './terminal-host-foreground-group-identity'

/** Full-capture identity may be reused only while the PTY's foreground group, its leader and the agent are unchanged. */
type SteadyStateAnchor = {
  agentName: string
  foregroundGroup: number
  /** Group leader, then the agent when a wrapper leads the group. */
  pids: readonly number[]
  identity: string
  rawFallback: string | null
}

// Key by Session so a new session or recycled PID cannot inherit an old anchor.
const anchors = new WeakMap<Session, SteadyStateAnchor>()

export function clearSteadyStateAnchor(session: Session): void {
  anchors.delete(session)
}

/** Only verified live agent identity can establish an anchor for cheap polling. */
export async function rememberSteadyStateAnchor(
  session: Session,
  evidence: RemoteForegroundEvidence
): Promise<void> {
  anchors.delete(session)
  if (
    evidence.verdict !== 'live' ||
    evidence.processName === null ||
    !recognizeAgentProcess(evidence.processName) ||
    evidence.fence.platform !== 'posix' ||
    !evidence.fence.process
  ) {
    return
  }
  const foregroundGroup = evidence.fence.foregroundPgid
  if (session.readForegroundGroup() !== foregroundGroup) {
    return
  }
  const pids = [...new Set([foregroundGroup, evidence.fence.process.pid])]
  const identity = await readForegroundGroupIdentity(pids, foregroundGroup)
  if (identity === null || session.readForegroundGroup() !== foregroundGroup) {
    return
  }
  anchors.set(session, {
    agentName: evidence.processName,
    foregroundGroup,
    pids,
    identity,
    rawFallback: session.getForegroundProcess({ rawFallback: true })
  })
}

/** The anchored agent while tcgetpgrp and per-pid reads of the group leader and agent still match the full capture. */
export async function readAnchoredForeground(session: Session): Promise<string | null> {
  const anchor = anchors.get(session)
  if (
    !anchor ||
    session.readForegroundGroup() !== anchor.foregroundGroup ||
    session.getForegroundProcess({ rawFallback: true }) !== anchor.rawFallback
  ) {
    return null
  }
  const identity = await readForegroundGroupIdentity(anchor.pids, anchor.foregroundGroup)
  return identity === anchor.identity && session.readForegroundGroup() === anchor.foregroundGroup
    ? anchor.agentName
    : null
}
