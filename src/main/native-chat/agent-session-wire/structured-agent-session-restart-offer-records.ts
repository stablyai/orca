import type { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import type { AgentSessionResumeMarker } from '../../../shared/agent-session-resume-marker'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

export type StructuredAgentSessionRestartOfferRecords = {
  readMarkers: () => Promise<AgentSessionResumeMarker[]>
  /** Retry failures only when explicitly named; unselective actions use pending offers alone. */
  readActionMarkers: (
    sessionIds: readonly string[] | undefined
  ) => Promise<AgentSessionResumeMarker[]>
  revealMarkers: (markers: readonly AgentSessionResumeMarker[]) => Promise<void>
  revealEvery: () => Promise<void>
  /** Delete superseded offers; advisory prune failure must not fail the triggering read. */
  retireSuperseded: (superseded: readonly AgentSessionResumeMarker[]) => void
}

export function createStructuredAgentSessionRestartOfferRecords(deps: {
  capsule?: Pick<AgentSessionRecoveryCapsule, 'list' | 'forgetSuperseded'>
  readFailedMarkers: () => Promise<AgentSessionResumeMarker[]>
  hasSession: (sessionId: string) => boolean
  reveal: (sessionId: string) => Promise<void>
  logger: StructuredAgentSessionLogger
  now: () => number
  /** Share the capsule mutation lane with offer operations. */
  enqueue: <T>(operation: () => Promise<T>) => Promise<T>
}): StructuredAgentSessionRestartOfferRecords {
  const readMarkers = async (): Promise<AgentSessionResumeMarker[]> => {
    try {
      return (await deps.capsule?.list(deps.now())) ?? []
    } catch {
      // Advisory read failure preserves bytes and ordinary chat; explicit dismissal may still remove them.
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
