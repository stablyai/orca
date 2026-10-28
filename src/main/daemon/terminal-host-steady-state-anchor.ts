import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import type { RemoteForegroundEvidence } from '../../shared/foreground-process-evidence'
import { buildPaneProcessFingerprint } from '../providers/posix-pane-foreground-fingerprint'
import {
  markPaneFingerprintVerified,
  type RevalidatedPaneFingerprint
} from '../providers/pane-fingerprint-revalidation'
import type { Session } from './session'

/** Full-capture identity may be reused only while its raw foreground name matches and its pane fingerprint still holds. */
export type SteadyStateAnchor = RevalidatedPaneFingerprint & {
  agentName: string
  rawFallback: string | null
}

// Key by Session so a new session or recycled PID cannot inherit an old anchor.
const anchors = new WeakMap<Session, SteadyStateAnchor>()

export function getSteadyStateAnchor(session: Session): SteadyStateAnchor | null {
  return anchors.get(session) ?? null
}

export function clearSteadyStateAnchor(session: Session): void {
  anchors.delete(session)
}

/** Only verified live agent identity can establish an anchor for cheap polling. */
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
  const anchor: SteadyStateAnchor = {
    agentName: evidence.processName,
    fingerprint,
    rawFallback: session.getForegroundProcess({ rawFallback: true })
  }
  markPaneFingerprintVerified(anchor)
  anchors.set(session, anchor)
}
