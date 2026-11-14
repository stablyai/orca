// Keep actionable failures after offers are spent; retire on independent startup, successful retry or dismissal.

import type {
  AgentSessionRecoveryCapsule,
  AgentSessionResumeSelection,
  AgentSessionResumeDisposition
} from '../../../runtime/agent-session/records/agent-session-recovery-capsule'
import type { AgentSessionResumeFailureRecord } from '../../../runtime/agent-session/records/agent-session-recovery-capsule-entries'
import type { AgentSessionConversationView } from '../../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import type {
  AgentSessionResumeFailureOutcome,
  AgentSessionResumeMarker
} from '../../../../shared/agent-session/lifecycle/agent-session-resume-marker'
import {
  normalizeOptionalField,
  AGENT_MODEL_MAX_LENGTH
} from '../../../../shared/agent-status/contracts/agent-status-field-normalization'

import type {
  StructuredAgentSessionRestartAudience,
  StructuredAgentSessionResumeCandidate,
  StructuredAgentSessionResumeFailure
} from './structured-agent-session-restart-resume-set'
import {
  STRUCTURED_AGENT_SESSION_RESUME_NOT_ELIGIBLE,
  STRUCTURED_AGENT_SESSION_RESUME_DEFERRED,
  STRUCTURED_AGENT_SESSION_RESUME_UNKNOWN,
  type StructuredAgentSessionResumeOutcome
} from './structured-agent-session-restart-resume-runner'
import {
  type StructuredAgentSessionContinuationOutcome,
  RESTART_CONTINUATION_SUPERSEDED
} from './structured-agent-session-restart-continuation'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'

type FailureCapsule = Pick<
  AgentSessionRecoveryCapsule,
  'listFailed' | 'settleResume' | 'dismiss' | 'clearAll' | 'forgetWitnesses'
>

export type StructuredAgentSessionRestartFailureLedger = {
  read: () => Promise<AgentSessionResumeFailureRecord[]>
  /** Saved failure rows a surface can show; retry eligibility is checked separately. */
  list: (
    failures?: readonly AgentSessionResumeFailureRecord[]
  ) => Promise<StructuredAgentSessionResumeFailure[]>
  /** Reconcile only the exact selected witnesses, in one capsule transaction. */
  settleSelected: (
    selections: readonly AgentSessionResumeSelection[],
    outcomes: readonly StructuredAgentSessionResumeOutcome[],
    action: {
      candidates: readonly StructuredAgentSessionResumeCandidate[]
      /** Retain marker message IDs for older readers. */
      markers: ReadonlyMap<string, AgentSessionResumeMarker>
      /** Continuation outcome decides failure; reattachment alone proves no delivery. */
      failureAfterResume: (sessionId: string) => AgentSessionResumeFailureOutcome | null
      failureReason: (sessionId: string) => string
      reconcile?: (
        selection: AgentSessionResumeSelection,
        disposition: AgentSessionResumeDisposition
      ) => AgentSessionResumeDisposition | null
    }
  ) => Promise<void>
  /** Dismiss only visible agents/records; unnamed dismissal preserves newer chats and adds no fence. */
  dismiss: (
    sessionIds: readonly string[] | undefined,
    beforeClearAll: (audience?: StructuredAgentSessionRestartAudience) => void | Promise<void>,
    audience?: StructuredAgentSessionRestartAudience
  ) => Promise<number>
}

export function continuationFailureOutcome(
  outcome: StructuredAgentSessionContinuationOutcome['outcome']
): AgentSessionResumeFailureOutcome | null {
  return outcome === 'continued' ? null : outcome === 'refused' ? 'refused' : 'unconfirmed'
}

export function createStructuredAgentSessionRestartFailureLedger(deps: {
  capsule?: FailureCapsule
  getRecord: (sessionId: string) => AgentSessionConversationView | null
  evaluate: (marker: AgentSessionResumeMarker) => { cancelled: boolean; retryable: boolean }
  /** Preserve newer-chat failures for compatible builds, hidden here. */
  savedByNewerOrca: (sessionId: string) => boolean
  logger: StructuredAgentSessionLogger
  now: () => number
  /** Share the capsule mutation lane with offer operations. */
  enqueue: <T>(operation: () => Promise<T>) => Promise<T>
}): StructuredAgentSessionRestartFailureLedger {
  const read = async (): Promise<AgentSessionResumeFailureRecord[]> => {
    try {
      return (await deps.capsule?.listFailed(deps.now())) ?? []
    } catch {
      // Advisory recovery failures must not block ordinary chat.
      deps.logger.warn('reading restart failures from the recovery capsule failed', {
        scope: 'recovery-capsule-read'
      })
      return []
    }
  }

  const toRow = (
    failure: AgentSessionResumeFailureRecord,
    retryable: boolean
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
        retryable
      }
    ]
  }

  const list = async (
    supplied?: readonly AgentSessionResumeFailureRecord[]
  ): Promise<StructuredAgentSessionResumeFailure[]> => {
    const failures = supplied ?? (await read())
    const cancelled: AgentSessionResumeFailureRecord[] = []
    const rows: StructuredAgentSessionResumeFailure[] = []
    for (const failure of failures) {
      const verdict = deps.evaluate(failure.marker)
      if (verdict.cancelled) {
        cancelled.push(failure)
      } else {
        rows.push(...toRow(failure, verdict.retryable))
      }
    }
    if (cancelled.length) {
      void deps
        .enqueue(
          () =>
            deps.capsule?.forgetWitnesses(
              cancelled.map((failure) => failure.marker),
              deps.now()
            ) ?? Promise.resolve()
        )
        .catch(() => {
          deps.logger.warn('pruning cancelled restart failures failed', {
            scope: 'restart-offer-prune'
          })
        })
    }
    return rows
  }

  const settleSelected: StructuredAgentSessionRestartFailureLedger['settleSelected'] = async (
    selections,
    outcomes,
    action
  ) => {
    const capsule = deps.capsule
    if (!capsule) {
      return
    }
    const dispositions = new Map<string, AgentSessionResumeDisposition>()
    // Retry retains the original prompt; its rejected continuation may now be the newest message.
    const promptBySession = new Map([
      ...action.candidates.map(
        (candidate) => [candidate.sessionId, candidate.latestPrompt] as const
      ),
      ...(await read()).map((filed) => [filed.marker.sessionId, filed.latestPrompt] as const)
    ])
    for (const outcome of outcomes) {
      const resumed = outcome.outcome === 'resumed'
      if (outcome.reason === STRUCTURED_AGENT_SESSION_RESUME_DEFERRED) {
        continue
      }
      // Newer-chat refusal files nothing; rollback retains the offer for a compatible build.
      if (
        !resumed &&
        outcome.reason === 'agent_session_journal_unreadable' &&
        outcome.details?.reason === 'journalWrittenByNewerOrca'
      ) {
        continue
      }
      // Ineligible/superseded offers are spent without retryable failure.
      const failure = resumed
        ? action.failureAfterResume(outcome.sessionId)
        : outcome.reason === STRUCTURED_AGENT_SESSION_RESUME_NOT_ELIGIBLE ||
            outcome.reason === RESTART_CONTINUATION_SUPERSEDED
          ? null
          : outcome.reason === STRUCTURED_AGENT_SESSION_RESUME_UNKNOWN
            ? 'unconfirmed'
            : 'refused'
      if (failure === null) {
        dispositions.set(outcome.sessionId, { kind: 'complete' })
        continue
      }
      dispositions.set(outcome.sessionId, {
        kind: 'failed',
        failure: {
          sessionId: outcome.sessionId,
          failedAt: deps.now(),
          outcome: failure,
          reason: resumed
            ? action.failureReason(outcome.sessionId)
            : (outcome.reason ?? 'agent_session_resume_refused'),
          ...(!resumed && outcome.details ? { details: outcome.details } : {}),
          latestPrompt: promptBySession.get(outcome.sessionId) ?? '',
          latestUserItemId: action.markers.get(outcome.sessionId)?.latestUserItemId ?? null
        }
      })
    }
    await deps
      .enqueue(() =>
        capsule.settleResume(selections, deps.now(), (selection) => {
          const disposition = dispositions.get(selection.marker.sessionId)
          return disposition
            ? action.reconcile
              ? action.reconcile(selection, disposition)
              : disposition
            : null
        })
      )
      .catch(() => {
        deps.logger.warn('settling restart offers failed', { scope: 'restart-offer-settlement' })
      })
  }

  return {
    read,
    list,
    settleSelected,
    dismiss: (sessionIds, beforeClearAll, audience) =>
      deps.enqueue(async () => {
        if (audience) {
          // Under capsule lock, keep unreadable/unshown agents and newer chats outside this audience.
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
          // Process-local late writes serialize after dismissal, so this path needs no fence.
          return (await deps.capsule?.dismiss(sessionIds ?? 'all', deps.now(), hidden)) ?? 0
        }
        if (sessionIds !== undefined) {
          return (await deps.capsule?.dismiss(sessionIds, deps.now())) ?? 0
        }
        await beforeClearAll()
        // Dismiss only shown records; newer chats belong to compatible builds.
        const keep = (marker: AgentSessionResumeMarker) => deps.savedByNewerOrca(marker.sessionId)
        return (await deps.capsule?.clearAll(deps.now(), keep)) ?? 0
      })
  }
}
