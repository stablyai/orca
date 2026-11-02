import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import type { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type { StructuredAgentSessionConversationLifetime } from './structured-agent-session-conversation-lifetime'
import type { StructuredAgentSessionConversationDelivery } from './structured-agent-session-host-delivery'
import type { StructuredAgentSessionClientDelivery } from './structured-agent-session-client-delivery'
import type { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'
import type { StructuredAgentSessionEventRecovery } from './structured-agent-session-event-recovery'
import type { wireStructuredAgentSessionQueuedMessages } from './structured-agent-session-queued-wiring'
import { createStructuredAgentSessionHostMutationContext } from './structured-agent-session-host-mutation-wiring'

export function structuredAgentSessionHostContexts(
  read: () => {
    deps: StructuredAgentSessionHostDeps
    sessions: StructuredAgentSessionConversations
    runtimeState: StructuredAgentSessionHostRuntimeState
    lifetime: StructuredAgentSessionConversationLifetime
    conversationDelivery: StructuredAgentSessionConversationDelivery
    clientDelivery: StructuredAgentSessionClientDelivery
    tasks: StructuredAgentSessionTaskQueue
    eventRecovery: StructuredAgentSessionEventRecovery
    queued: ReturnType<typeof wireStructuredAgentSessionQueuedMessages>
    now: () => number
  }
) {
  const lifetime = () => {
    const c = read()
    return {
      deps: c.deps,
      runtimeState: c.runtimeState,
      sessions: c.sessions,
      now: c.now,
      publishStatus: c.clientDelivery.publishStatus,
      generationEnded: c.clientDelivery.publishGenerationEnded,
      wakeDelivery: (id: string) => c.conversationDelivery.loop.wake(id),
      endExitedChild: c.eventRecovery.endExitedChildUnderSerialize
    }
  }
  const attach = () => {
    const c = read()
    return {
      ...lifetime(),
      subscribers: c.clientDelivery.subscribers,
      tasks: c.tasks,
      reconcileLeases: (id: string) => c.runtimeState.reconcileLeases(id),
      serialize: c.tasks.serialize.bind(c.tasks),
      openProviderChild: c.eventRecovery.openProviderChild,
      openConversation: c.conversationDelivery.open
    }
  }
  const mutation = () => {
    const c = read()
    return createStructuredAgentSessionHostMutationContext({
      deps: c.deps,
      sessions: c.sessions,
      subscribers: c.clientDelivery.subscribers,
      lifetime: c.lifetime,
      clientDelivery: c.clientDelivery,
      conversationDelivery: c.conversationDelivery,
      queued: c.queued,
      runtimeState: c.runtimeState,
      attachContext: attach,
      trackProviderOperation: <T>(operation: Promise<T>) => c.tasks.trackAttach(operation),
      serialize: c.tasks.serialize.bind(c.tasks),
      now: c.now
    })
  }
  return { lifetime, attach, mutation }
}
