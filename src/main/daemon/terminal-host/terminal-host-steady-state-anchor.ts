import { recognizeAgentProcess } from '../../../shared/agent-status/process/agent-process-recognition'
import type { RemoteForegroundEvidence } from '../../../shared/terminal/pty/foreground/foreground-process-evidence'
import { getCheapProcessTableSnapshot } from '../../../shared/process-observation/tables/cheap-process-table-snapshot-reader'
import { buildPaneProcessFingerprint } from '../../providers/foreground/posix-pane-fingerprint'
import type { Session } from '../sessions/session'
import { readForegroundGroupMembers } from './terminal-host-foreground-group-identity'

/** Full-capture identity may be reused only while the PTY's foreground group and its anchored live members are unchanged. */
type SteadyStateAnchor = {
  agentName: string
  rawFallback: string | null
} & (
  | {
      kind: 'members'
      foregroundGroup: number
      /** The agent, plus the group leader when it is a live wrapper; a pipeline's leader may have exited. */
      pids: readonly number[]
      identity: string
    }
  /** While per-pid reads are unavailable (native reader backing off or missing), the pane's table fingerprint. */
  | { kind: 'fingerprint'; fingerprint: string }
)

// Key by Session so a new session or recycled PID cannot inherit an old anchor.
const anchors = new WeakMap<Session, SteadyStateAnchor>()

export function clearSteadyStateAnchor(session: Session): void {
  anchors.delete(session)
}

/** Only verified live agent identity can establish an anchor for cheap polling. */
export async function rememberSteadyStateAnchor(
  session: Session,
  evidence: RemoteForegroundEvidence,
  rows: Parameters<typeof buildPaneProcessFingerprint>[0]
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
  const liveGroup = session.readForegroundGroup()
  if (typeof liveGroup === 'number' && liveGroup !== foregroundGroup) {
    return
  }
  const agentPid = evidence.fence.process.pid
  // A PTY image that cannot report its foreground group (older node-pty) keeps the table fingerprint.
  const members =
    typeof liveGroup === 'number'
      ? await readForegroundGroupMembers([...new Set([foregroundGroup, agentPid])], foregroundGroup)
      : null
  const rawFallback = session.getForegroundProcess({ rawFallback: true })
  if (members === null) {
    const fingerprint = await buildPaneProcessFingerprint(rows, session.pid).catch(() => null)
    if (fingerprint !== null) {
      anchors.set(session, {
        kind: 'fingerprint',
        agentName: evidence.processName,
        rawFallback,
        fingerprint
      })
    }
    return
  }
  if (!members.has(agentPid) || session.readForegroundGroup() !== foregroundGroup) {
    return
  }
  const pids = [...members.keys()]
  anchors.set(session, {
    kind: 'members',
    agentName: evidence.processName,
    rawFallback,
    foregroundGroup,
    pids,
    identity: memberIdentity(members, pids)
  })
}

/** The anchored agent while tcgetpgrp and per-pid reads of the anchored members (agent, plus a live leader) still match. */
export async function readAnchoredForeground(session: Session): Promise<string | null> {
  const anchor = anchors.get(session)
  if (!anchor || session.getForegroundProcess({ rawFallback: true }) !== anchor.rawFallback) {
    return null
  }
  if (anchor.kind === 'fingerprint') {
    try {
      const observed = await buildPaneProcessFingerprint(
        await getCheapProcessTableSnapshot(),
        session.pid
      )
      return observed === anchor.fingerprint ? anchor.agentName : null
    } catch {
      return null
    }
  }
  if (session.readForegroundGroup() !== anchor.foregroundGroup) {
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
