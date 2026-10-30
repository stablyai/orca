import { StructuredAgentSessionEventRecovery } from './structured-agent-session-event-recovery'
import type { StructuredAgentSessionConversationDelivery } from './structured-agent-session-host-delivery'
import { configureStructuredQuestionImport } from './structured-agent-session-question-import'
import type { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { createStructuredAgentSessionConversationDelivery } from './structured-agent-session-host-delivery'
import { claimStructuredAgentSessionAgent } from './structured-agent-session-agent-start'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import type { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type { StructuredAgentSessionClientDelivery } from './structured-agent-session-client-delivery'
import type { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { StructuredAgentSessionConversationLifetime } from './structured-agent-session-conversation-lifetime'

export function wireHostConversationDelivery(input: {
  deps: StructuredAgentSessionHostDeps
  sessions: StructuredAgentSessionConversations
  runtimeState: StructuredAgentSessionHostRuntimeState
  clientDelivery: StructuredAgentSessionClientDelivery
  tasks: StructuredAgentSessionTaskQueue
  serialize: Parameters<typeof createStructuredAgentSessionConversationDelivery>[0]['serialize']
  attachContext: () => StructuredAgentSessionAttachContext
  lifetime: () => StructuredAgentSessionConversationLifetime
}) {
  const { deps, sessions, runtimeState, clientDelivery, tasks } = input
  return createStructuredAgentSessionConversationDelivery({
    deps,
    acquireAborts: runtimeState.acquireAborts,
    sessions,
    serialize: (sessionId, task) => input.serialize(sessionId, task),
    // Quit drains tracked starts before eviction so their children are stopped.
    trackStart: (start) => tasks.trackAttach(start),
    startProviderChild: (sessionId, startedFor) =>
      claimStructuredAgentSessionAgent(input.attachContext(), sessionId, startedFor),
    deliveryOrder: runtimeState.deliveryOrder,
    startFlights: runtimeState.startFlights,
    readiness: (id, child) => runtimeState.startupAttempts.readiness(id, child),
    // Retire at rest; the next start refreshes login and permission mode.
    stopOutgrownAgent: (id) => input.lifetime().stopAgent(id, { cause: 'evict', resting: true }),
    clientDelivery
  })
}

export function configureHostQuestionImport(
  deps: StructuredAgentSessionHostDeps,
  sessions: StructuredAgentSessionConversations,
  subscribers: AgentSessionSubscribers,
  sessionId: string
): void {
  const journal = sessions.get(sessionId)?.journal
  if (journal) {
    configureStructuredQuestionImport(
      journal,
      () => deps.store.getConversation(sessionId),
      (workspaceId) =>
        deps.resolveWorkspacePath?.(workspaceId) ??
        Promise.reject(new Error('Question source workspace unavailable')),
      () => {
        if (sessions.get(sessionId)?.journal === journal) {
          subscribers.republishCurrentRequests(sessionId, journal)
        }
      }
    )
  }
}

export function wireHostEventRecovery(input: {
  deps: StructuredAgentSessionHostDeps
  sessions: StructuredAgentSessionConversations
  runtimeState: StructuredAgentSessionHostRuntimeState
  clientDelivery: StructuredAgentSessionClientDelivery
  tasks: StructuredAgentSessionTaskQueue
  serialize: StructuredAgentSessionTaskQueue['serialize']
  now: () => number
  delivery: () => StructuredAgentSessionConversationDelivery
  lifetime: () => StructuredAgentSessionConversationLifetime
}) {
  const { deps, sessions, runtimeState, clientDelivery, tasks } = input
  return new StructuredAgentSessionEventRecovery({
    deps,
    store: deps.store,
    sessions,
    flushLifecycle: (sessionId) => runtimeState.lifecycleBarrier(sessionId),
    publishStatus: clientDelivery.publishStatusAndSettlement,
    generationEnded: clientDelivery.publishGenerationEnded,
    serialize: (sessionId, task) => tasks.trackAttach(input.serialize(sessionId, task)),
    now: () => input.now(),
    runtimeState,
    wakeDelivery: (sessionId) => input.delivery().loop.wake(sessionId),
    stopStartingChild: (...args) => input.lifetime().stopStartingChild(...args),
    failStartingChild: (...args) => input.lifetime().failStartingChild(...args),
    trackOpen: (open) => tasks.trackAttach(open)
  })
}
