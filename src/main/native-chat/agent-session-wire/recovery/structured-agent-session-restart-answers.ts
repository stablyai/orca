// A restart action ends once its chats are handed over; each chat's answer settles only that chat.

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

/** How long a handed-over chat's answer may take before its offer is spent without one. Under a
 *  burst of starts, agents can take minutes to answer; the chat itself shows that progress. */
const RESTART_ANSWER_WAIT_MS = 150_000

export function createRestartAnswers() {
  /** Handed-over chats, each settling once its agent answers or its wait runs out. */
  const answers = new Map<string, Promise<void>>()
  /** Every answer so far, including those that arrive after the action returned. */
  const continued: StructuredAgentSessionContinuationOutcome[] = []

  /** Settles the chats that already have an answer; the rest settle on their own afterwards.
   *  Returns the chats still waiting for theirs. */
  async function settle(
    action: {
      operationId: string
      outcomes: readonly StructuredAgentSessionResumeOutcome[]
      candidates: readonly StructuredAgentSessionResumeCandidate[]
      markers: ReadonlyMap<string, AgentSessionResumeMarker>
    },
    failures: Pick<StructuredAgentSessionRestartFailureLedger, 'settle'>,
    logger: StructuredAgentSessionLogger
  ): Promise<ReadonlySet<string>> {
    const answered = new Set(continued.map((entry) => entry.sessionId))
    const waiting = new Set([...answers.keys()].filter((sessionId) => !answered.has(sessionId)))
    const settleChats = (chats: (sessionId: string) => boolean, last: boolean) =>
      failures.settle(
        action.operationId,
        action.outcomes.filter((outcome) => chats(outcome.sessionId)),
        {
          candidates: action.candidates,
          markers: action.markers,
          // No answer within the wait is no failure: the chat shows its own progress.
          failureAfterResume: (sessionId) => {
            const outcome = continued.find((entry) => entry.sessionId === sessionId)
            return outcome ? continuationFailureOutcome(outcome.outcome) : null
          },
          failureReason: (sessionId) => {
            const outcome = continued.find((entry) => entry.sessionId === sessionId)
            return outcome?.reason ?? outcome?.outcome ?? 'agent_session_continuation_unknown'
          }
        },
        last
      )
    await settleChats((sessionId) => !waiting.has(sessionId), waiting.size === 0)
    if (waiting.size > 0) {
      void Promise.all(
        [...waiting].map(async (sessionId) => {
          await answers.get(sessionId)
          await settleChats((id) => id === sessionId, false)
        })
      )
        .then(() => settleChats(() => false, true))
        .catch(() => {
          logger.warn('settling late restart continuations failed', {
            scope: 'restart-offer-settle',
            operationId: action.operationId
          })
        })
    }
    return waiting
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
