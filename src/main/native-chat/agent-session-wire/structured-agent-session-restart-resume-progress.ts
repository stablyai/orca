import { randomUUID } from 'node:crypto'
import type { StructuredAgentSessionContinuationOutcome } from './structured-agent-session-restart-continuation'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionRestartOfferSession } from './structured-agent-session-restart-offer-withdrawal'

type Phase = NonNullable<AgentSessionStatusSummary['restartResume']>['phase']

/** Progress belongs to the action, never to the durable recovery obligation. */
export function createRestartResumeProgress(
  sessions: ReadonlyMap<string, StructuredAgentSessionRestartOfferSession>,
  publish: ((sessionId: string) => void) | undefined
) {
  const operationId = randomUUID()
  const owned = new Map<string, StructuredAgentSessionRestartOfferSession>()
  const skipped: string[] = []
  let active = true
  return {
    skipped,
    skipExcluded(requested: readonly string[], admitted: readonly { sessionId: string }[]): void {
      const admittedIds = new Set(admitted.map((entry) => entry.sessionId))
      for (const sessionId of new Set(requested)) {
        if (!admittedIds.has(sessionId)) {
          skipped.push(sessionId)
          this.set(sessionId, 'skipped')
        }
      }
    },
    set(sessionId: string, phase: Phase): void {
      if (!active) {
        return
      }
      const session = sessions.get(sessionId)
      if (!session) {
        return
      }
      if (phase === 'queued' || phase === 'skipped') {
        // Excluding a request cannot take progress away from an admitted action.
        if (
          session.restartResume &&
          (phase === 'skipped' || session.restartResume.phase !== 'skipped')
        ) {
          return
        }
        owned.set(sessionId, session)
      } else if (session.restartResume?.operationId !== operationId) {
        return
      }
      session.restartResume = { operationId, phase }
      publish?.(sessionId)
    },
    verdict(outcome: StructuredAgentSessionContinuationOutcome): void {
      this.set(
        outcome.sessionId,
        outcome.outcome === 'continued'
          ? 'continued'
          : outcome.outcome === 'refused'
            ? 'refused'
            : 'unconfirmed'
      )
    },
    clear(): void {
      active = false
      for (const [sessionId, session] of owned) {
        if (session.restartResume?.operationId !== operationId) {
          continue
        }
        delete session.restartResume
        publish?.(sessionId)
      }
      owned.clear()
    }
  }
}
