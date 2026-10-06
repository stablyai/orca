// The durable side of the restart offer, as one action or listing reads it: which markers exist,
// making their chats readable here, and deleting the ones the user's own send has ended.

import type { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import type { AgentSessionResumeMarker } from '../../../shared/agent-session-resume-marker'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

export type StructuredAgentSessionRestartOfferRecords = {
  /** Every pending offer. Read-only; nothing is spent. */
  readMarkers: () => Promise<AgentSessionResumeMarker[]>
  /** The markers an explicit action may act on: every pending offer, plus a recorded failure when
   *  the action names it — a retry. An unselective action never re-runs a failure. */
  readActionMarkers: (
    sessionIds: readonly string[] | undefined
  ) => Promise<AgentSessionResumeMarker[]>
  revealMarkers: (markers: readonly AgentSessionResumeMarker[]) => Promise<void>
  /** Reveals the chat of every offer and every recorded failure. */
  revealEvery: () => Promise<void>
  /** A user's newer message ended these offers; delete them rather than re-filter forever.
   *  Advisory: a failed prune must never fail the read that noticed it. */
  retireSuperseded: (superseded: readonly AgentSessionResumeMarker[]) => void
}

export function createStructuredAgentSessionRestartOfferRecords(deps: {
  capsule?: Pick<AgentSessionRecoveryCapsule, 'list' | 'forgetSuperseded'>
  readFailedMarkers: () => Promise<AgentSessionResumeMarker[]>
  hasSession: (sessionId: string) => boolean
  reveal: (sessionId: string) => Promise<void>
  logger: StructuredAgentSessionLogger
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
      deps.logger.warn('reading restart offers from the recovery capsule failed', {
        scope: 'recovery-capsule-read'
      })
      return []
    }
  }
  const revealMarkers = async (markers: readonly AgentSessionResumeMarker[]): Promise<void> => {
    for (const marker of markers) {
      if (!deps.hasSession(marker.sessionId)) {
        await deps.reveal(marker.sessionId)
      }
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
    revealMarkers,
    revealEvery: async () =>
      revealMarkers([...(await readMarkers()), ...(await deps.readFailedMarkers())]),
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
          deps.logger.warn('pruning superseded restart offers failed', {
            scope: 'restart-offer-prune'
          })
        })
    }
  }
}
