// A restart action ends once its chats are handed over; their answers settle afterwards, together.

import type { AgentSessionResumeMarker } from '../../../../shared/agent-session/lifecycle/resume/agent-session-resume-marker'
import { withTimeout } from '../../../../shared/concurrency/promise-timeout-fallback'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'
import type { StructuredAgentSessionContinuationOutcome } from './structured-agent-session-restart-continuation'
import {
  continuationFailureOutcome,
  type StructuredAgentSessionRestartFailureLedger
} from './structured-agent-session-restart-failure-ledger'
import type { StructuredAgentSessionResumeOutcome } from './structured-agent-session-restart-resume-runner'
import type { StructuredAgentSessionResumeCandidate } from './structured-agent-session-restart-resume-set'

/** How long a handed-over chat's answer may take before it is filed as unconfirmed. Under a burst
 *  of starts agents can take minutes; an answer the provider accepts later retires that record. */
const RESTART_ANSWER_WAIT_MS = 150_000

export function createRestartAnswers() {
  /** Handed-over chats, each settling once its agent answers or its wait runs out. */
  const answers = new Map<string, Promise<void>>()
  /** Every answer so far, including those that arrive after the action returned. */
  const continued: StructuredAgentSessionContinuationOutcome[] = []

  /** Settles the chats that already have an answer now, and the rest in one later pass once each
   *  has answered or run out of time, so a recovery record is never spent without a verdict.
   *  Returns the chats still waiting and that later pass. */
  async function settle(
    action: {
      operationId: string
      outcomes: readonly StructuredAgentSessionResumeOutcome[]
      candidates: readonly StructuredAgentSessionResumeCandidate[]
      markers: ReadonlyMap<string, AgentSessionResumeMarker>
    },
    failures: Pick<StructuredAgentSessionRestartFailureLedger, 'settle'>,
    logger: StructuredAgentSessionLogger
  ): Promise<{ waiting: ReadonlySet<string>; settled: Promise<void> }> {
    const answered = new Set(continued.map((entry) => entry.sessionId))
    const waiting = new Set([...answers.keys()].filter((sessionId) => !answered.has(sessionId)))
    const outcomeOf = (sessionId: string) =>
      continued.find((entry) => entry.sessionId === sessionId)
    const settleChats = (chats: (sessionId: string) => boolean, last: boolean) =>
      failures.settle(
        action.operationId,
        action.outcomes.filter((outcome) => chats(outcome.sessionId)),
        {
          candidates: action.candidates,
          markers: action.markers,
          failureAfterResume: (sessionId) => {
            const outcome = outcomeOf(sessionId)
            if (outcome) {
              return continuationFailureOutcome(outcome.outcome)
            }
            // Still unanswered: keep its record, as an accepted late answer retires it.
            return waiting.has(sessionId) ? 'unconfirmed' : null
          },
          failureReason: (sessionId) => {
            const outcome = outcomeOf(sessionId)
            return outcome?.reason ?? outcome?.outcome ?? 'agent_session_continuation_unknown'
          }
        },
        last
      )
    if (waiting.size === 0) {
      await settleChats(() => true, true)
      return { waiting, settled: Promise.resolve() }
    }
    await settleChats((sessionId) => !waiting.has(sessionId), false)
    const settled = Promise.all(
      [...waiting].map((sessionId) => answers.get(sessionId) ?? Promise.resolve())
    )
      .then(() => settleChats((sessionId) => waiting.has(sessionId), true))
      .catch(() => {
        logger.warn('settling late restart continuations failed', {
          scope: 'restart-offer-settle',
          operationId: action.operationId
        })
      })
    return { waiting, settled }
  }

  return {
    continued,
    /** A chat whose continuation was handed over; `answer` resolves with its agent's answer. */
    handedOver(sessionId: string, answer: Promise<StructuredAgentSessionContinuationOutcome>) {
      const recorded = answer.then((outcome) => {
        continued.push(outcome)
      })
      answers.set(sessionId, withTimeout(recorded, RESTART_ANSWER_WAIT_MS, undefined))
    },
    settle
  }
}
