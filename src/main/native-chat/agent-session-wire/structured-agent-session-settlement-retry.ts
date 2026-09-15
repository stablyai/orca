import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { attachJournal } from './structured-agent-session-attach'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import type { StructuredAgentSessionLeaseStore } from './structured-agent-session-lease-release'
import { turnVerdictFromDeathEvidence } from './structured-agent-session-stale-turn-verdict'
import {
  captureUnfinishedStructuredAgentSessionWork,
  settleStructuredAgentSessionDeadGeneration,
  unfinishedStructuredAgentSessionWorkWasInterrupted
} from './structured-agent-session-dead-generation-settlement'

export async function retryPendingStructuredAgentSessionSettlement(input: {
  deps: StructuredAgentSessionHostDeps
  sessions: Map<string, StructuredAgentSessionHostSession>
  sessionId: string
  params: AgentSessionAttachParams
  now: () => number
}): Promise<boolean> {
  const record = input.deps.store.getRecord(input.sessionId)
  if (!record?.lease.settlementRetryRequired || !record.lease.settlementRetryId) {
    return true
  }
  let journal = input.sessions.get(input.sessionId)?.journal
  if (!journal) {
    try {
      journal = (
        await attachJournal({
          record,
          params: input.params,
          journalRoot: input.deps.journalRoot,
          adapter: input.deps.adapter
        })
      ).journal
    } catch (error) {
      input.deps.onEventSinkError?.({ sessionId: input.sessionId, error })
      return false
    }
  }
  const current = input.sessions.get(input.sessionId)
  const retrySession =
    current ??
    ({
      journal,
      params: input.params,
      fence: record.lease.runtimeFence,
      hasProviderChild: false,
      acquisitionGeneration: null
    } as StructuredAgentSessionHostSession)
  return retryLoadedStructuredAgentSessionSettlement({
    deps: input.deps,
    sessionId: input.sessionId,
    session: retrySession,
    now: input.now
  })
}

export async function retryLoadedStructuredAgentSessionSettlement(input: {
  deps: {
    store: StructuredAgentSessionLeaseStore
    onEventSinkError?: StructuredAgentSessionHostDeps['onEventSinkError']
  }
  sessionId: string
  session: Pick<StructuredAgentSessionHostSession, 'journal' | 'fence' | 'acquisitionGeneration'>
  now: () => number
}): Promise<boolean> {
  const record = input.deps.store.getRecord(input.sessionId)
  if (!record?.lease.settlementRetryRequired || !record.lease.settlementRetryId) {
    return true
  }
  const retrySession = input.session
  retrySession.fence = record.lease.runtimeFence
  const onError = (id: string, error: unknown): void =>
    input.deps.onEventSinkError?.({ sessionId: id, error })
  // Only an observed exit earns an end time; a probe-proven death never saw one.
  const verdict = turnVerdictFromDeathEvidence(record.lease.deathEvidence)
  const ok = await settleStructuredAgentSessionDeadGeneration({
    journal: retrySession.journal,
    sessionId: input.sessionId,
    fence: retrySession.fence,
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
        captureUnfinishedStructuredAgentSessionWork(retrySession.journal),
        retrySession.journal,
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
      // A dead-TUI retry still needs its stopped-owner stage; recovery-only stages end here.
      const preserveHandoff = latest.lease.handoffStage === 'old-owner-stopped'
      return {
        ...latest,
        lease: {
          ...latest.lease,
          handoffStage: preserveHandoff ? latest.lease.handoffStage : null,
          handoffOperationId: preserveHandoff ? latest.lease.handoffOperationId : null,
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
