import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import type { RemoteForegroundEvidence } from '../../shared/foreground-process-evidence'
import { buildPaneProcessFingerprint } from '../providers/posix-pane-foreground-fingerprint'
import type { Session } from './session'

/**
 * What the last FULL capture proved about a pane: a recognized agent name, the pane subtree
 * fingerprint at that moment, and node-pty's raw foreground name at that moment. A later cheap
 * tick may re-serve `agentName` only while both of the latter still match.
 */
export type SteadyStateAnchor = {
  agentName: string
  fingerprint: string
  rawFallback: string | null
}

// Weakly keyed: an anchor dies with its Session, and a recycled pid under a new Session can
// never inherit one. Retired sessions fail `isAlive` before any read gets here regardless.
const anchors = new WeakMap<Session, SteadyStateAnchor>()

export function getSteadyStateAnchor(session: Session): SteadyStateAnchor | null {
  return anchors.get(session) ?? null
}

export function clearSteadyStateAnchor(session: Session): void {
  anchors.delete(session)
}

/**
 * Record (or drop) the anchor after a full capture. Only a `live` verdict naming a recognized
 * agent establishes one: the cheap tier is licensed by proven identity, never by a fallback name
 * or an unverifiable read, so a pane without one always pays for the full capture.
 */
export async function rememberSteadyStateAnchor(
  session: Session,
  evidence: RemoteForegroundEvidence,
  rows: Parameters<typeof buildPaneProcessFingerprint>[0]
): Promise<void> {
  if (evidence.verdict !== 'live' || !recognizeAgentProcess(evidence.processName)) {
    anchors.delete(session)
    return
  }
  let fingerprint: string | null
  try {
    fingerprint = await buildPaneProcessFingerprint(rows, session.pid)
  } catch {
    fingerprint = null
  }
  if (fingerprint === null || evidence.processName === null) {
    anchors.delete(session)
    return
  }
  anchors.set(session, {
    agentName: evidence.processName,
    fingerprint,
    rawFallback: session.getForegroundProcess({ rawFallback: true })
  })
}
