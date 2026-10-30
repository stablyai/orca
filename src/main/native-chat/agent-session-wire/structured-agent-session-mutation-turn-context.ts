import type { AgentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
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
  const persistedOptions = request.store.getRecord(sessionId)?.options
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
  return {
    sessionId: record.sessionId,
    journal,
    fence: record.currentFence,
    agent: record.provider,
    ...(request.currentWork ? { currentWork: request.currentWork } : {}),
    ...(record.options ? { persistedOptions: record.options } : {}),
    now: request.now
  }
}
