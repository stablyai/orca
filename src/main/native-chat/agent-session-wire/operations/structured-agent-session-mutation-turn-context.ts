import type { AgentSessionConversationView } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import { effectiveAgentSessionOptions } from '../../../runtime/agent-session/records/agent-session-record-options'
import type { AgentSessionMutationRequest } from './structured-agent-session-mutation-admission'
import type {
  AgentSessionReplayContext,
  AgentSessionTurnContext
} from './structured-agent-session-turns'

export function mutationTurnContext<TValue>(
  request: Omit<AgentSessionMutationRequest<TValue>, 'plan'>,
  journal: AgentSessionJournal,
  record: AgentSessionRecord
): AgentSessionTurnContext {
  const fence = record.lease.runtimeFence
  const { sessionId } = request.envelope
  const saved = request.store.getRecord(sessionId)
  const persistedOptions = saved && effectiveAgentSessionOptions(saved)
  return {
    sessionId,
    journal,
    fence,
    ...(request.currentWork ? { currentWork: request.currentWork } : {}),
    ...(request.readWork ? { readWork: request.readWork } : {}),
    adapter: request.adapter,
    agents: request.agents,
    agent: record.provider,
    logger: request.logger,
    ...(persistedOptions ? { persistedOptions } : {}),
    modelDefault: saved?.defaultModelOptions !== undefined,
    persistOptions: (options) =>
      request.store
        .replaceSessionOptions({
          sessionId: request.envelope.sessionId,
          fence,
          options,
          now: request.now()
        })
        .then(() => undefined),
    resolvedBy: request.callerKey,
    publish: () => request.publish(journal),
    now: () => request.now()
  }
}

export function mutationReplayContext<TValue>(
  request: Omit<AgentSessionMutationRequest<TValue>, 'plan'>,
  journal: AgentSessionJournal,
  record: AgentSessionConversationView
): AgentSessionReplayContext {
  const persistedOptions = effectiveAgentSessionOptions(record)
  return {
    sessionId: record.sessionId,
    journal,
    fence: record.currentFence,
    agent: record.provider,
    ...(request.currentWork ? { currentWork: request.currentWork } : {}),
    ...(persistedOptions ? { persistedOptions } : {}),
    modelDefault: record.defaultModelOptions !== undefined,
    now: request.now
  }
}
