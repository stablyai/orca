import { recognizeAgentProcess } from '../../../shared/agent-status/process/agent-process-recognition'
import type { RemoteForegroundEvidence } from '../../../shared/terminal/pty/foreground/foreground-process-evidence'
import type { Session } from '../sessions/session'
import { readForegroundGroupMembers } from './terminal-host-foreground-group-identity'

/** Full-capture identity may be reused only while the PTY's foreground group and its anchored live members are unchanged. */
type SteadyStateAnchor = {
  agentName: string
  foregroundGroup: number
  /** The agent, plus the group leader when it is a live wrapper; a pipeline's leader may have exited. */
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
  const agentPid = evidence.fence.process.pid
  const members = await readForegroundGroupMembers(
    [...new Set([foregroundGroup, agentPid])],
    foregroundGroup
  )
  if (!members?.has(agentPid) || session.readForegroundGroup() !== foregroundGroup) {
    return
  }
  const pids = [...members.keys()]
  const identity = memberIdentity(members, pids)
  anchors.set(session, {
    agentName: evidence.processName,
    foregroundGroup,
    pids,
    identity,
    rawFallback: session.getForegroundProcess({ rawFallback: true })
  })
}

/** The anchored agent while tcgetpgrp and per-pid reads of the anchored members (agent, plus a live leader) still match. */
export async function readAnchoredForeground(session: Session): Promise<string | null> {
  const anchor = anchors.get(session)
  if (
    !anchor ||
    session.readForegroundGroup() !== anchor.foregroundGroup ||
    session.getForegroundProcess({ rawFallback: true }) !== anchor.rawFallback
  ) {
    return null
  }
  const members = await readForegroundGroupMembers(anchor.pids, anchor.foregroundGroup)
  return members !== null &&
    memberIdentity(members, anchor.pids) === anchor.identity &&
    session.readForegroundGroup() === anchor.foregroundGroup
    ? anchor.agentName
    : null
}

function memberIdentity(members: ReadonlyMap<number, string>, pids: readonly number[]): string {
  return pids.map((pid) => members.get(pid) ?? `${pid}:gone`).join('|')
}
