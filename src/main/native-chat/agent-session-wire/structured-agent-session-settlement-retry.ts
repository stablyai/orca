import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { attachJournal } from './structured-agent-session-attach'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import {
  retryUnexpectedExitSettlement,
  type StructuredAgentSessionUnexpectedExitContext
} from './structured-agent-session-unexpected-exit'

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
  retrySession.fence = record.lease.runtimeFence
  const context: StructuredAgentSessionUnexpectedExitContext = {
    store: input.deps.store,
    sessions: input.sessions,
    flushLifecycle: async () => ({ ok: true as const }),
    publishFence: () => undefined,
    hasResumeCapableHolder: () => false,
    serialize: async <T>(_id: string, task: () => Promise<T>) => task(),
    now: input.now,
    onBarrierError: (id, error) => input.deps.onEventSinkError?.({ sessionId: id, error })
  }
  const ok = await retryUnexpectedExitSettlement({
    context,
    event: {
      type: 'ended',
      sessionId: input.sessionId,
      reason: record.lease.deathEvidence?.detail ?? 'provider exited',
      cause: 'unexpected-exit',
      fence: record.lease.runtimeFence,
      acquisitionGeneration: current?.acquisitionGeneration ?? 'recovery'
    },
    session: retrySession,
    stableSettlementId: record.lease.settlementRetryId
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
