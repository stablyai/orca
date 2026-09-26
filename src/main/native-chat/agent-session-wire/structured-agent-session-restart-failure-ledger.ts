// What became of the offers an action spent, kept for the surfaces that must still name them.
//
// The toast that reports a chat Orca could not carry on is gone in seconds and the reattach spends
// the offer, so without this record nothing durable would point at the chat the user has to
// continue by hand. The capsule holds the record; this decides what goes in and when it leaves.
//
// Whether a record is still current is derived, never cached: it is current only while the chat's
// newest user message is the one it had when the failure was filed. The user's own send, from any
// client, therefore retires it without a hook on the send path.

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
import type { AgentJournalSnapshot } from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { latestStructuredAgentSessionUserItem } from '../../../shared/structured-agent-session-projection'
import { normalizeOptionalField } from '../../../shared/agent-status-field-normalization'
import { AGENT_MODEL_MAX_LENGTH } from '../../../shared/agent-status-types'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { adapterSupportsRecord } from './structured-agent-session-provider-support'
import {
  liveStructuredAgentSessionLatestUserItemId,
  type StructuredAgentSessionRestartJournalSource
} from './structured-agent-session-restart-candidates'
import type { StructuredAgentSessionContinuationOutcome } from './structured-agent-session-restart-continuation'
import type {
  StructuredAgentSessionResumeCandidate,
  StructuredAgentSessionResumeFailure
} from './structured-agent-session-restart-resume-set'
import {
  STRUCTURED_AGENT_SESSION_RESUME_NOT_ELIGIBLE,
  type StructuredAgentSessionResumeOutcome
} from './structured-agent-session-restart-resume-runner'

type FailureCapsule = Pick<
  AgentSessionRecoveryCapsule,
  | 'listFailed'
  | 'completeResume'
  | 'failResume'
  | 'rollbackResume'
  | 'dismiss'
  | 'clearAll'
  | 'forgetSuperseded'
>

/** What a failure is filed against: the chat's newest user message as its own attempt ended. Kept
 *  per chat rather than read at settlement, because the rest of a batch can take a while and a
 *  message the user sends meanwhile answers the failure rather than belongs to it. */
export type StructuredAgentSessionRestartAttempts = {
  observe: (sessionId: string) => void
  latestUserItemId: (sessionId: string) => string | null
}

export type StructuredAgentSessionRestartFailureLedger = {
  /** The stored records, current or not. */
  read: () => Promise<AgentSessionResumeFailureRecord[]>
  /** The current records as rows a surface can show; sessions this host no longer holds are left
   *  out, and records the chat has since superseded are dropped and pruned. */
  list: () => Promise<StructuredAgentSessionResumeFailure[]>
  /** One action's attempts; a chat never observed after an attempt falls back to its reserved
   *  marker. */
  attempts: (
    markers: ReadonlyMap<string, AgentSessionResumeMarker>
  ) => StructuredAgentSessionRestartAttempts
  /** Settles one operation's reservations: the agent carried on, or the failure is filed. Rows the
   *  operation still owns after that are reopened. */
  settle: (
    operationId: string,
    outcomes: readonly StructuredAgentSessionResumeOutcome[],
    action: {
      candidates: readonly StructuredAgentSessionResumeCandidate[]
      attempts: StructuredAgentSessionRestartAttempts
      /** How a reattached session's action ended; null when the agent carried on. Reattaching alone
       *  is not the whole action, so the runner's own outcome cannot decide this. */
      failureAfterResume: (sessionId: string) => AgentSessionResumeFailureOutcome | null
      failureReason: (sessionId: string) => string
    }
  ) => Promise<void>
  /** Named sessions forget their offer or failure; unnamed, every durable record goes. */
  dismiss: (
    sessionIds: readonly string[] | undefined,
    beforeClearAll: () => void
  ) => Promise<number>
}

/** Which continuation outcomes count as the agent not carrying on, and how each is filed. */
export function continuationFailureOutcome(
  outcome: StructuredAgentSessionContinuationOutcome['outcome']
): AgentSessionResumeFailureOutcome | null {
  return outcome === 'continued' ? null : outcome === 'refused' ? 'refused' : 'unconfirmed'
}

/** Whether the chat itself has moved past a failure: a newer user message, or, for a delivery
 *  nobody confirmed, a turn the continuation's own message opened. */
function failureAnsweredByChat(
  failure: AgentSessionResumeFailureRecord,
  snapshot: AgentJournalSnapshot
): boolean {
  const latest = latestStructuredAgentSessionUserItem(snapshot.items)?.itemId ?? null
  if (latest !== failure.latestUserItemId) {
    return true
  }
  // Only when the continuation's message was journaled: otherwise the newest user message is the
  // interrupted one, whose own turn proves nothing about the continuation.
  return (
    failure.outcome === 'unconfirmed' &&
    latest !== null &&
    latest !== failure.marker.latestUserItemId &&
    newestTurnUserItemId(snapshot) === latest
  )
}

/** The user message that opened the newest root turn, resolved through a provider key the send was
 *  accepted under. */
function newestTurnUserItemId(snapshot: AgentJournalSnapshot): string | null {
  for (let index = snapshot.items.length - 1; index >= 0; index -= 1) {
    const item = snapshot.items[index]
    const turn = isRootAgentJournalItem(item) ? readAgentJournalTurn(item?.body) : null
    if (!turn) {
      continue
    }
    const key = turn.userItemId
    if (key === undefined) {
      return null
    }
    const accepted = snapshot.submissions.find((entry) => entry.providerItemId === key)
    return accepted ? agentJournalSubmissionKey(accepted.clientMessageId) : key
  }
  return null
}

export function createStructuredAgentSessionRestartFailureLedger(deps: {
  capsule?: FailureCapsule
  sessions: ReadonlyMap<string, StructuredAgentSessionRestartJournalSource>
  /** Makes a persisted chat's journal readable here, as listing an offer does. */
  reveal: (sessionId: string) => Promise<void>
  getRecord: (sessionId: string) => AgentSessionRecord | null
  adapter: StructuredAgentSessionAdapter
  /** The predicate a retry applies to the failure's marker. */
  retryable: (marker: AgentSessionResumeMarker) => boolean
  now: () => number
  /** The capsule's single mutation lane, shared with the offer's own operations. */
  enqueue: <T>(operation: () => Promise<T>) => Promise<T>
}): StructuredAgentSessionRestartFailureLedger {
  const read = async (): Promise<AgentSessionResumeFailureRecord[]> => {
    try {
      return (await deps.capsule?.listFailed(deps.now())) ?? []
    } catch {
      // Recovery is advisory; a malformed capsule must not make ordinary chat actions unusable.
      console.warn('[structured-agent-session] reading recovery capsule failed')
      return []
    }
  }

  const toRow = (
    failure: AgentSessionResumeFailureRecord
  ): StructuredAgentSessionResumeFailure[] => {
    const record = deps.getRecord(failure.marker.sessionId)
    if (!record || !adapterSupportsRecord(deps.adapter, record)) {
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
        retryable: deps.retryable(failure.marker)
      }
    ]
  }

  const list = async (): Promise<StructuredAgentSessionResumeFailure[]> => {
    const current: AgentSessionResumeFailureRecord[] = []
    const superseded: AgentSessionResumeFailureRecord[] = []
    for (const failure of await read()) {
      const sessionId = failure.marker.sessionId
      if (!deps.sessions.has(sessionId)) {
        await deps.reveal(sessionId)
      }
      const snapshot = deps.sessions.get(sessionId)?.journal.snapshot()
      // An unreadable journal decides nothing; the record stays until something that can decide.
      if (snapshot && failureAnsweredByChat(failure, snapshot)) {
        superseded.push(failure)
      } else {
        current.push(failure)
      }
    }
    const capsule = deps.capsule
    if (capsule && superseded.length > 0) {
      const gone = superseded.map((failure) => ({
        sessionId: failure.marker.sessionId,
        recordedAt: failure.marker.recordedAt,
        failedAt: failure.failedAt
      }))
      void deps
        .enqueue(() => capsule.forgetSuperseded(gone, deps.now()))
        .catch(() => {
          console.warn('[structured-agent-session] pruning superseded restart failures failed')
        })
    }
    return current.flatMap(toRow)
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
    const promptBySession = new Map(
      action.candidates.map((candidate) => [candidate.sessionId, candidate.latestPrompt])
    )
    for (const outcome of outcomes) {
      const resumed = outcome.outcome === 'resumed'
      // Ineligible means the user moved on or the offer no longer applies (record gone,
      // conversation forked), so there is nothing to retry and the offer is spent.
      const failure = resumed
        ? action.failureAfterResume(outcome.sessionId)
        : outcome.reason === STRUCTURED_AGENT_SESSION_RESUME_NOT_ELIGIBLE
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
        latestPrompt: promptBySession.get(outcome.sessionId) ?? '',
        latestUserItemId: action.attempts.latestUserItemId(outcome.sessionId)
      })
    }
    await deps
      .enqueue(() => capsule.completeResume(operationId, completed, deps.now()))
      .catch(() => {
        console.warn('[structured-agent-session] restart offer completion failed')
      })
    // Filed before the rollback so a failure the user must act on is never reopened as an offer
    // that would silently re-run it.
    await deps
      .enqueue(() => capsule.failResume(operationId, failures, deps.now()))
      .catch(() => {
        console.warn('[structured-agent-session] restart failure record failed')
      })
    // This only reopens rows still owned by this operation. Rows removed by completeResume stay
    // removed, even when the write of a later bookkeeping step fails.
    await deps
      .enqueue(() => capsule.rollbackResume(operationId, deps.now()))
      .catch(() => {
        console.warn('[structured-agent-session] restart offer rollback failed')
      })
  }

  const attempts: StructuredAgentSessionRestartFailureLedger['attempts'] = (markers) => {
    const observed = new Map<string, string | null>()
    return {
      // Observed after the attempt, so the continuation's own message is part of the filed state.
      observe: (sessionId) => {
        const latest = liveStructuredAgentSessionLatestUserItemId(deps.sessions, sessionId)
        if (latest !== undefined) {
          observed.set(sessionId, latest)
        }
      },
      latestUserItemId: (sessionId) => {
        const latest = observed.get(sessionId)
        return latest !== undefined ? latest : (markers.get(sessionId)?.latestUserItemId ?? null)
      }
    }
  }

  return {
    read,
    list,
    attempts,
    settle,
    dismiss: (sessionIds, beforeClearAll) =>
      deps.enqueue(async () => {
        if (sessionIds !== undefined) {
          return (await deps.capsule?.dismiss(sessionIds, deps.now())) ?? 0
        }
        beforeClearAll()
        return (await deps.capsule?.clearAll(deps.now())) ?? 0
      })
  }
}
