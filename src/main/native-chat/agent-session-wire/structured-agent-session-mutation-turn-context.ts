import type { AgentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { AgentSessionMutationRequest } from './structured-agent-session-mutation-admission'
import type {
  AgentSessionReplayContext,
  AgentSessionTurnContext
} from './structured-agent-session-turns'
import { effectiveAgentSessionOptions } from '../../../shared/agent-session-default-model'

export function mutationTurnContext<TValue>(
  request: Omit<AgentSessionMutationRequest<TValue>, 'plan'>,
  journal: AgentSessionJournal,
  record: AgentSessionRecord
): AgentSessionTurnContext {
  const fence = record.lease.runtimeFence
  const { sessionId } = request.envelope
  const current = request.store.getRecord(sessionId)
  const persistedOptions = current ? effectiveAgentSessionOptions(current) : undefined
  return {
    sessionId,
    journal,
    fence,
    ...(request.currentWork ? { currentWork: request.currentWork } : {}),
    adapter: request.adapter,
    agents: request.agents,
    agent: record.provider,
    logger: request.logger,
    ...(persistedOptions ? { persistedOptions } : {}),
    defaultModelSelected: current?.defaultModelOptions !== undefined,
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
    defaultModelSelected: record.defaultModelOptions !== undefined,
    agent: record.provider,
    ...(request.currentWork ? { currentWork: request.currentWork } : {}),
    ...(persistedOptions ? { persistedOptions } : {}),
    now: request.now
  }
}
