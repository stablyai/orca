import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import type { StructuredAgentSessionLeaseStore } from './structured-agent-session-lease-release'
import { turnVerdictFromDeathEvidence } from './structured-agent-session-stale-turn-verdict'
import {
  captureUnfinishedStructuredAgentSessionWork,
  settleStructuredAgentSessionDeadGeneration,
  unfinishedStructuredAgentSessionWorkWasInterrupted,
  type DeadGenerationJournal
} from './structured-agent-session-dead-generation-settlement'

/** Whether a restart or an exit left this record's turn owed a settlement. The one definition:
 *  every trigger that retries (the attach, a start, the startup pass) asks this. */
export function structuredAgentSessionOwesSettlement(
  record: AgentSessionRecord | null
): record is AgentSessionRecord & {
  lease: AgentSessionRecord['lease'] & { settlementRetryId: string }
} {
  return record?.lease.settlementRetryRequired === true && !!record.lease.settlementRetryId
}

/** Retries a durable provider-exit settlement against the conversation's own journal. The retry is
 *  for an earlier child, so it writes at the record's fence and leaves the conversation — and any
 *  message queued for the next child — alone. */
export async function retryPendingStructuredAgentSessionSettlement(input: {
  deps: StructuredAgentSessionHostDeps
  sessionId: string
  /** The conversation's journal, opened through the host's one open when it is closed. */
  openJournal: () => Promise<AgentSessionJournal | null>
  now: () => number
}): Promise<boolean> {
  const record = input.deps.store.getRecord(input.sessionId)
  if (!structuredAgentSessionOwesSettlement(record)) {
    return true
  }
  let journal: AgentSessionJournal | null
  try {
    journal = await input.openJournal()
  } catch (error) {
    input.deps.onEventSinkError?.({ sessionId: input.sessionId, error })
    return false
  }
  return journal
    ? retryLoadedStructuredAgentSessionSettlement({
        deps: input.deps,
        sessionId: input.sessionId,
        journal,
        now: input.now
      })
    : false
}

export async function retryLoadedStructuredAgentSessionSettlement(input: {
  deps: {
    store: StructuredAgentSessionLeaseStore
    onEventSinkError?: StructuredAgentSessionHostDeps['onEventSinkError']
  }
  sessionId: string
  journal: DeadGenerationJournal
  now: () => number
}): Promise<boolean> {
  const record = input.deps.store.getRecord(input.sessionId)
  if (!structuredAgentSessionOwesSettlement(record)) {
    return true
  }
  const { journal } = input
  const fence = record.lease.runtimeFence
  const onError = (id: string, error: unknown): void =>
    input.deps.onEventSinkError?.({ sessionId: id, error })
  // Only an observed exit earns an end time; a probe-proven death never saw one.
  const verdict = turnVerdictFromDeathEvidence(record.lease.deathEvidence)
  const ok = await settleStructuredAgentSessionDeadGeneration({
    journal,
    sessionId: input.sessionId,
    fence,
    settlementId: record.lease.settlementRetryId,
    pendingSubmissionReason: 'provider_exited_before_acknowledgement',
    verdict,
    // The same evidence decides the copy: only a witnessed death is worth telling the user
    // about. An unverifiable one is a restart artefact, and the session stays sendable. The
    // work check matches the live exit path — a provider that died waiting on a prompt
    // interrupted no response, so it must not claim one was in progress.
    showUnexpectedExitOutcome:
      verdict.state === 'interrupted' &&
      unfinishedStructuredAgentSessionWorkWasInterrupted(
        captureUnfinishedStructuredAgentSessionWork(journal),
        journal,
        verdict.completedAt
      ),
    ...(record.lease.deathEvidence?.detail
      ? { unexpectedExitReason: record.lease.deathEvidence.detail }
      : {}),
    onError
  })
  if (!ok) {
    return false
  }
  try {
    await input.deps.store.transitionHandoff(input.sessionId, (latest) => {
      if (
        latest.lease.runtimeFence !== record.lease.runtimeFence ||
        !latest.lease.settlementRetryRequired
      ) {
        throw new Error('agent_session_checkpoint_stale')
      }
      return {
        ...latest,
        lease: {
          ...latest.lease,
          handoffStage: null,
          handoffOperationId: null,
          settlementRetryRequired: undefined,
          settlementRetryId: undefined,
          lastRenewedAt: input.now()
        }
      }
    })
    return true
  } catch (error) {
    input.deps.onEventSinkError?.({ sessionId: input.sessionId, error })
    return false
  }
}
