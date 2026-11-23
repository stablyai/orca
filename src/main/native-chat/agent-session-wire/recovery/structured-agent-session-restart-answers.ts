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

/** How long an action's handed-over chats may take to answer before the rest are settled as
 *  unconfirmed. Under a burst of starts agents can take minutes; a later answer still applies. */
const RESTART_ANSWER_WAIT_MS = 150_000

export function createRestartAnswers() {
  /** Handed-over chats: `answered` settles once the agent answers (or the verdict fails). */
  const answers = new Map<string, { answered: Promise<void>; giveUp: () => Promise<void> }>()
  /** Every answer so far, including those that arrive after the action returned. */
  const continued: StructuredAgentSessionContinuationOutcome[] = []

  /** Files failures of chats that already have an answer now, and settles everything else in one
   *  later pass once each chat has answered or the action's deadline passed, so a recovery record
   *  is never spent without a verdict. Returns the chats still waiting and that later pass. */
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
    // Early refusals are filed now, so they show at once; completions wait for the last pass.
    const filedEarly = new Set(await settleChats((sessionId) => !waiting.has(sessionId), false))
    // One deadline for the whole action, not a timer per chat.
    const settled = withTimeout(
      Promise.all([...waiting].map((sessionId) => answers.get(sessionId)?.answered)),
      RESTART_ANSWER_WAIT_MS,
      undefined
    )
      .then(async () => {
        // Each unanswered chat settles on its own: its row, its queue and its note.
        const unanswered = [...waiting].filter((sessionId) => !outcomeOf(sessionId))
        await Promise.all(unanswered.map((sessionId) => answers.get(sessionId)?.giveUp()))
      })
      .then(() => settleChats((sessionId) => !filedEarly.has(sessionId), true))
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
    /** A chat whose continuation was handed over; `answer` resolves with its agent's answer and
     *  `giveUp` settles it as unconfirmed when the action's deadline passes first. */
    handedOver(
      sessionId: string,
      answer: Promise<StructuredAgentSessionContinuationOutcome>,
      giveUp: () => Promise<void>
    ) {
      const answered = answer.then(
        (outcome) => {
          continued.push(outcome)
        },
        () => {}
      )
      answers.set(sessionId, { answered, giveUp })
    },
    settle
  }
}
