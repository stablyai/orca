// The context an admitted mutation's plan runs in, built from the request that admitted it.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { AgentSessionMutationRequest } from './structured-agent-session-mutation-admission'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'
import { structuredAgentSessionCurrentWork } from './structured-agent-session-current-work'

export function mutationTurnContext<TValue>(
  request: AgentSessionMutationRequest<TValue>,
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
    currentWork: () => {
      const ended = request.endedChild?.()
      return structuredAgentSessionCurrentWork(journal, {
        record: request.store.getRecord(sessionId),
        replaced: request.store.replacedRuntime(sessionId),
        ...(ended ? { ended } : {})
      })
    },
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
