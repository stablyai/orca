// The durable side of the restart offer, as one action or listing reads it: which markers exist,
// making their chats readable here, and deleting the ones the user's own send has ended.

import type { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import type { AgentSessionResumeMarker } from '../../../shared/agent-session-resume-marker'

export type StructuredAgentSessionRestartOfferRecords = {
  /** Every pending offer. Read-only; nothing is spent. */
  readMarkers: () => Promise<AgentSessionResumeMarker[]>
  /** The markers an explicit action may act on: every pending offer, plus a recorded failure when
   *  the action names it — a retry. An unselective action never re-runs a failure. */
  readActionMarkers: (
    sessionIds: readonly string[] | undefined
  ) => Promise<AgentSessionResumeMarker[]>
  revealMarkers: (markers: readonly AgentSessionResumeMarker[]) => Promise<void>
  /** A user's newer message ended these offers; delete them rather than re-filter forever.
   *  Advisory: a failed prune must never fail the read that noticed it. */
  retireSuperseded: (superseded: readonly AgentSessionResumeMarker[]) => void
}

export function createStructuredAgentSessionRestartOfferRecords(deps: {
  capsule?: Pick<AgentSessionRecoveryCapsule, 'list' | 'forgetSuperseded'>
  readFailedMarkers: () => Promise<AgentSessionResumeMarker[]>
  hasSession: (sessionId: string) => boolean
  reveal: (sessionId: string) => Promise<void>
  now: () => number
  /** The capsule's single mutation lane, shared with the offer's own operations. */
  enqueue: <T>(operation: () => Promise<T>) => Promise<T>
}): StructuredAgentSessionRestartOfferRecords {
  const readMarkers = async (): Promise<AgentSessionResumeMarker[]> => {
    try {
      return (await deps.capsule?.list(deps.now())) ?? []
    } catch {
      // Recovery is advisory. A malformed capsule must not make ordinary chat actions unusable;
      // the durable bytes stay untouched so an explicit dismissal can remove them.
      console.warn('[structured-agent-session] reading recovery capsule failed')
      return []
    }
  }
  return {
    readMarkers,
    readActionMarkers: async (sessionIds) => {
      const pending = await readMarkers()
      if (sessionIds === undefined) {
        return pending
      }
      const named = new Set(sessionIds)
      const retried = (await deps.readFailedMarkers()).filter((marker) =>
        named.has(marker.sessionId)
      )
      return [...pending, ...retried]
    },
    revealMarkers: async (markers) => {
      for (const marker of markers) {
        if (!deps.hasSession(marker.sessionId)) {
          await deps.reveal(marker.sessionId)
        }
      }
    },
    retireSuperseded: (superseded) => {
      const capsule = deps.capsule
      if (!capsule || superseded.length === 0) {
        return
      }
      const gone = superseded.map((marker) => ({
        sessionId: marker.sessionId,
        recordedAt: marker.recordedAt
      }))
      void deps
        .enqueue(() => capsule.forgetSuperseded(gone, deps.now()))
        .catch(() => {
          console.warn('[structured-agent-session] pruning superseded restart offers failed')
        })
    }
  }
}
