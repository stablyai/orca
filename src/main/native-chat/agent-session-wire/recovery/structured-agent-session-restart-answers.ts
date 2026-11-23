// A restart action ends once its chats are handed over; their answers settle afterwards, together.

import type { AgentSessionResumeMarker } from '../../../../shared/agent-session/lifecycle/resume/agent-session-resume-marker'
import { withTimeout } from '../../../../shared/concurrency/promise-timeout-fallback'
import { mapWithConcurrency } from '../../../../shared/concurrency/map-with-concurrency'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'
import type { StructuredAgentSessionContinuationOutcome } from './structured-agent-session-restart-continuation'
import {
  continuationFailureOutcome,
  type StructuredAgentSessionRestartFailureLedger
} from './structured-agent-session-restart-failure-ledger'
import {
  STRUCTURED_AGENT_SESSION_RESUME_CONCURRENCY,
  type StructuredAgentSessionResumeOutcome
} from './structured-agent-session-restart-resume-runner'
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
    // Indexed once per pass: a lookup per chat must not scan every answer.
    let byChat = new Map(continued.map((entry) => [entry.sessionId, entry]))
    const waiting = new Set([...answers.keys()].filter((sessionId) => !byChat.has(sessionId)))
    const outcomeOf = (sessionId: string) => byChat.get(sessionId)
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
      Promise.all(
        [...waiting].map((sessionId) => answers.get(sessionId)?.answered ?? Promise.resolve())
      ),
      RESTART_ANSWER_WAIT_MS,
      undefined
    )
      .then(async () => {
        byChat = new Map(continued.map((entry) => [entry.sessionId, entry]))
        // Each unanswered chat settles on its own (its row, its queue and its note), a few at a time.
        const unanswered = [...waiting].filter((sessionId) => !outcomeOf(sessionId))
        await mapWithConcurrency(
          unanswered,
          STRUCTURED_AGENT_SESSION_RESUME_CONCURRENCY,
          (sessionId) => answers.get(sessionId)?.giveUp() ?? Promise.resolve()
        )
      })
      .then(async () => {
        await settleChats((sessionId) => !filedEarly.has(sessionId), true)
      })
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
     *  `giveUp` settles it as unconfirmed when the action's deadline passes first. The agent may
     *  still take it later; that updates the message's delivery, not the note. */
    handedOver(
      sessionId: string,
      answer: Promise<StructuredAgentSessionContinuationOutcome>,
      giveUp: () => Promise<void>
    ) {
      const answered = answer.then(
        (outcome) => {
          // Still pending (e.g. its settlement wait was refused at capacity): no answer; the deadline decides.
          if (outcome.outcome === 'pending') {
            return new Promise<void>(() => {})
          }
          continued.push(outcome)
          return undefined
        },
        () => {}
      )
      answers.set(sessionId, { answered, giveUp })
    },
    settle
  }
}
