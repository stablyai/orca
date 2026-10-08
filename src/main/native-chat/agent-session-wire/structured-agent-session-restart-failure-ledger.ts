// What became of the offers an action spent, kept for the surfaces that must still name them.
//
// The reattach spends the offer, so this record is what the status bar and the resume dialog list,
// with a retry, for a chat Orca could not carry on. The capsule holds the record; this decides what
// goes in and when it leaves.
//
// A record ends when the chat's agent is started again outside a resume action — the host retires
// it at that start, with the offer — or by a successful retry, or a dismissal.

import type {
  AgentSessionRecoveryCapsule,
  AgentSessionResumeFailureInput,
  AgentSessionResumeFailureRecord
} from '../../runtime/agent-session-recovery-capsule'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionResumeFailureOutcome,
  AgentSessionResumeMarker
} from '../../../shared/agent-session-resume-marker'
import { normalizeOptionalField } from '../../../shared/agent-status-field-normalization'
import { AGENT_MODEL_MAX_LENGTH } from '../../../shared/agent-status-types'
import type { StructuredAgentSessionContinuationOutcome } from './structured-agent-session-restart-continuation'
import type {
  StructuredAgentSessionRestartAudience,
  StructuredAgentSessionResumeCandidate,
  StructuredAgentSessionResumeFailure
} from './structured-agent-session-restart-resume-set'
import {
  STRUCTURED_AGENT_SESSION_RESUME_NOT_ELIGIBLE,
  type StructuredAgentSessionResumeOutcome
} from './structured-agent-session-restart-resume-runner'
import { RESTART_CONTINUATION_SUPERSEDED } from './structured-agent-session-restart-continuation'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

type FailureCapsule = Pick<
  AgentSessionRecoveryCapsule,
  'listFailed' | 'completeResume' | 'failResume' | 'rollbackResume' | 'dismiss' | 'clearAll'
>

export type StructuredAgentSessionRestartFailureLedger = {
  /** The stored records, current or not. */
  read: () => Promise<AgentSessionResumeFailureRecord[]>
  /** The records as rows a surface can show; sessions this build cannot run are left out. */
  list: () => Promise<StructuredAgentSessionResumeFailure[]>
  /** Settles one operation's reservations: the agent carried on, or the failure is filed. Rows the
   *  operation still owns after that are reopened. */
  settle: (
    operationId: string,
    outcomes: readonly StructuredAgentSessionResumeOutcome[],
    action: {
      candidates: readonly StructuredAgentSessionResumeCandidate[]
      /** The reserved markers; a failure carries its marker's message id for older readers. */
      markers: ReadonlyMap<string, AgentSessionResumeMarker>
      /** How a reattached session's action ended; null when the agent carried on. Reattaching alone
       *  is not the whole action, so the runner's own outcome cannot decide this. */
      failureAfterResume: (sessionId: string) => AgentSessionResumeFailureOutcome | null
      failureReason: (sessionId: string) => string
    }
  ) => Promise<void>
  /** Named sessions forget their offer or failure; unnamed, every record this host lists goes (a
   *  newer Orca's stay). With an audience, only records of agents it sees go, and an unnamed
   *  dismissal is no fence. */
  dismiss: (
    sessionIds: readonly string[] | undefined,
    beforeClearAll: (audience?: StructuredAgentSessionRestartAudience) => void | Promise<void>,
    audience?: StructuredAgentSessionRestartAudience
  ) => Promise<number>
}

/** Which continuation outcomes count as the agent not carrying on, and how each is filed. */
export function continuationFailureOutcome(
  outcome: StructuredAgentSessionContinuationOutcome['outcome']
): AgentSessionResumeFailureOutcome | null {
  return outcome === 'continued' ? null : outcome === 'refused' ? 'refused' : 'unconfirmed'
}

export function createStructuredAgentSessionRestartFailureLedger(deps: {
  capsule?: FailureCapsule
  getRecord: (sessionId: string) => AgentSessionRecord | null
  /** The predicate a retry applies to the failure's marker. */
  retryable: (marker: AgentSessionResumeMarker) => boolean
  /** Whether a newer Orca saved the chat: its failure is kept for that Orca but not shown here,
   *  where no retry can land. */
  savedByNewerOrca: (sessionId: string) => boolean
  /** Makes the failed chats readable here, so `retryable` reads each one's journal. */
  reveal: (markers: readonly AgentSessionResumeMarker[]) => Promise<void>
  logger: StructuredAgentSessionLogger
  now: () => number
  /** The capsule's single mutation lane, shared with the offer's own operations. */
  enqueue: <T>(operation: () => Promise<T>) => Promise<T>
}): StructuredAgentSessionRestartFailureLedger {
  const read = async (): Promise<AgentSessionResumeFailureRecord[]> => {
    try {
      return (await deps.capsule?.listFailed(deps.now())) ?? []
    } catch {
      // Recovery is advisory; a malformed capsule must not make ordinary chat actions unusable.
      deps.logger.warn('reading restart failures from the recovery capsule failed', {
        scope: 'recovery-capsule-read'
      })
      return []
    }
  }

  const toRow = (
    failure: AgentSessionResumeFailureRecord
  ): StructuredAgentSessionResumeFailure[] => {
    const record = deps.getRecord(failure.marker.sessionId)
    if (!record || deps.savedByNewerOrca(failure.marker.sessionId)) {
      return []
    }
    const model = normalizeOptionalField(record.options?.model, AGENT_MODEL_MAX_LENGTH)
    return [
      {
        sessionId: failure.marker.sessionId,
        workspaceId: record.location.workspaceId,
        agent: record.provider,
        work: failure.marker.work,
        trigger: failure.marker.trigger,
        recordedAt: failure.marker.recordedAt,
        latestPrompt: failure.latestPrompt,
        executionHostId: record.location.executionHostId,
        workspaceKind: record.location.workspaceKind,
        ...(model === undefined ? {} : { model }),
        failedAt: failure.failedAt,
        outcome: failure.outcome,
        reason: failure.reason,
        ...(failure.details ? { details: failure.details } : {}),
        retryable: deps.retryable(failure.marker)
      }
    ]
  }

  const list = async (): Promise<StructuredAgentSessionResumeFailure[]> => {
    const failures = await read()
    await deps.reveal(failures.map((failure) => failure.marker))
    return failures.flatMap(toRow)
  }

  const settle: StructuredAgentSessionRestartFailureLedger['settle'] = async (
    operationId,
    outcomes,
    action
  ) => {
    const capsule = deps.capsule
    if (!capsule) {
      return
    }
    const completed: string[] = []
    const failures: AgentSessionResumeFailureInput[] = []
    // A retry keeps the prompt its first failure named: the chat's newest user message since then
    // is the rejected continuation, and a message of the user's own would have ended the offer.
    const promptBySession = new Map([
      ...action.candidates.map(
        (candidate) => [candidate.sessionId, candidate.latestPrompt] as const
      ),
      ...(await read()).map((filed) => [filed.marker.sessionId, filed.latestPrompt] as const)
    ])
    for (const outcome of outcomes) {
      const resumed = outcome.outcome === 'resumed'
      // A newer Orca's refusal spends nothing: the rollback below reopens the offer for the Orca
      // that can continue it, and nothing is filed for a chat no retry here could continue.
      if (
        !resumed &&
        outcome.reason === 'agent_session_journal_unreadable' &&
        outcome.details?.reason === 'journalWrittenByNewerOrca'
      ) {
        continue
      }
      // Ineligible means the offer no longer applies (record gone, conversation forked), and
      // superseded means the user's own message came first: nothing to retry, and the offer is spent.
      const failure = resumed
        ? action.failureAfterResume(outcome.sessionId)
        : outcome.reason === STRUCTURED_AGENT_SESSION_RESUME_NOT_ELIGIBLE ||
            outcome.reason === RESTART_CONTINUATION_SUPERSEDED
          ? null
          : 'refused'
      if (failure === null) {
        completed.push(outcome.sessionId)
        continue
      }
      failures.push({
        sessionId: outcome.sessionId,
        failedAt: deps.now(),
        outcome: failure,
        reason: resumed
          ? action.failureReason(outcome.sessionId)
          : (outcome.reason ?? 'agent_session_resume_refused'),
        ...(!resumed && outcome.details ? { details: outcome.details } : {}),
        latestPrompt: promptBySession.get(outcome.sessionId) ?? '',
        latestUserItemId: action.markers.get(outcome.sessionId)?.latestUserItemId ?? null
      })
    }
    await deps
      .enqueue(() => capsule.completeResume(operationId, completed, deps.now()))
      .catch(() => {
        deps.logger.warn('completing a restart offer failed', {
          scope: 'restart-offer-complete',
          operationId
        })
      })
    // Filed before the rollback so a failure the user must act on is never reopened as an offer
    // that would silently re-run it.
    await deps
      .enqueue(() => capsule.failResume(operationId, failures, deps.now()))
      .catch(() => {
        deps.logger.warn('recording a restart failure failed', {
          scope: 'restart-failure-record',
          operationId
        })
      })
    // This only reopens rows still owned by this operation. Rows removed by completeResume stay
    // removed, even when the write of a later bookkeeping step fails.
    await deps
      .enqueue(() => capsule.rollbackResume(operationId, deps.now()))
      .catch(() => {
        deps.logger.warn('rolling back a restart offer failed', {
          scope: 'restart-offer-rollback',
          operationId
        })
      })
  }

  return {
    read,
    list,
    settle,
    dismiss: (sessionIds, beforeClearAll, audience) =>
      deps.enqueue(async () => {
        if (audience) {
          // Decided under the capsule lock. A record whose chat this host cannot read names no
          // agent the audience was shown, so it stays.
          // An unnamed dismissal keeps a newer Orca's records too: they were never listed here.
          const hidden = (marker: AgentSessionResumeMarker) => {
            const record = deps.getRecord(marker.sessionId)
            return (
              record === null ||
              !audience(record.provider) ||
              (sessionIds === undefined && deps.savedByNewerOrca(marker.sessionId))
            )
          }
          if (sessionIds === undefined) {
            await beforeClearAll(audience)
          }
          // No fence: no client reaches this today (the local desktop gets no audience), and a
          // late write from this process is serialized behind the dismissal.
          return (await deps.capsule?.dismiss(sessionIds ?? 'all', deps.now(), hidden)) ?? 0
        }
        if (sessionIds !== undefined) {
          return (await deps.capsule?.dismiss(sessionIds, deps.now())) ?? 0
        }
        await beforeClearAll()
        // A newer Orca's offers and failures were never shown here, so "dismiss all" keeps them.
        const keep = (marker: AgentSessionResumeMarker) => deps.savedByNewerOrca(marker.sessionId)
        return (await deps.capsule?.clearAll(deps.now(), keep)) ?? 0
      })
  }
}
