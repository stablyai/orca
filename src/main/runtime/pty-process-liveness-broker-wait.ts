import type { PtyProcessEvidenceEntry } from './pty-process-liveness-broker-types'
import type { PtyProcessLivenessEvidence } from './pty-process-inspection'

export function waitForPtyProcessProbe(
  entries: ReadonlyMap<string, PtyProcessEvidenceEntry>,
  ptyId: string,
  entry: PtyProcessEvidenceEntry,
  timeoutMs: number | null
): Promise<PtyProcessLivenessEvidence> {
  const probe = entry.probe
  if (!probe) {
    return Promise.resolve(
      entry.evidence ?? { status: 'unverifiable', reason: 'process inspection unavailable' }
    )
  }
  if (timeoutMs === null) {
    return probe
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (entries.get(ptyId) === entry && entry.probe === probe) {
        entry.timedOut = true
      }
      resolve({ status: 'unverifiable', reason: 'process inspection timed out' })
    }, timeoutMs)
    void probe.then((evidence) => {
      clearTimeout(timeout)
      resolve(evidence)
    })
  })
}
