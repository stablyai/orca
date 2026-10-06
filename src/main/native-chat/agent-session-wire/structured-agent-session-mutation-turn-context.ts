// The context an admitted mutation's plan runs in, built from the request that admitted it.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { AgentSessionMutationRequest } from './structured-agent-session-mutation-admission'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'

export function mutationTurnContext<TValue>(
  request: AgentSessionMutationRequest<TValue>,
  journal: AgentSessionJournal,
  record: AgentSessionRecord
): AgentSessionTurnContext {
  const fence = record.lease.runtimeFence
  const persistedOptions = request.store.getRecord(request.envelope.sessionId)?.options
  return {
    sessionId: request.envelope.sessionId,
    journal,
    fence,
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
    ...(request.providerChildPhase ? { providerChildPhase: request.providerChildPhase } : {}),
    now: () => request.now()
  }
}
