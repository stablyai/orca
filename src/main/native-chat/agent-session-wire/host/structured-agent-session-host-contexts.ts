import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import type { createRestartTabHider } from './structured-agent-session-host-tabs'
import { createStructuredAgentSessionConversationReads } from './structured-agent-session-conversation-reads'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import type { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type { StructuredAgentSessionClientDelivery } from '../publication/subscribers/structured-agent-session-client-delivery'
import type { StructuredAgentSessionConversationDelivery } from '../delivery/structured-agent-session-host-delivery'
import type { StructuredAgentSessionEventRecovery } from '../termination/structured-agent-session-event-recovery'
import type { StructuredAgentSessionRestartResume } from '../recovery/structured-agent-session-restart-resume-contract'
import type { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'
import type { StructuredAgentSessionLifetimeContext } from '../termination/structured-agent-session-host-lifetime'
import type { StructuredAgentSessionAttachContext } from '../acquisition/structured-agent-session-attach-context'

/** Read collaborators lazily; attaching and teardown share the same ownership and cancellation facts. */
export function createStructuredAgentSessionHostContexts(
  read: () => {
    deps: StructuredAgentSessionHostDeps
    sessions: StructuredAgentSessionConversations
    runtimeState: StructuredAgentSessionHostRuntimeState
    clientDelivery: StructuredAgentSessionClientDelivery
    conversationDelivery: StructuredAgentSessionConversationDelivery
    eventRecovery: StructuredAgentSessionEventRecovery
    restartResume: StructuredAgentSessionRestartResume
    lifetimeConversation: (id: string) => Promise<StructuredAgentSessionHostSession>
    tasks: StructuredAgentSessionTaskQueue
    serialize: StructuredAgentSessionAttachContext['serialize']
    now: () => number
  }
) {
  const lifetime = () => {
    const host = read()
    return {
      deps: host.deps,
      runtimeState: host.runtimeState,
      sessions: host.sessions,
      now: host.now,
      publishStatus: host.clientDelivery.publishStatus,
      generationEnded: host.clientDelivery.publishGenerationEnded,
      wakeDelivery: (sessionId: string) => host.conversationDelivery.loop.wake(sessionId),
      hasUnacceptedRecovery: (sessionId: string) => host.restartResume.hasUnaccepted(sessionId),
      endExitedChild: host.eventRecovery.endExitedChildUnderSerialize
    } satisfies StructuredAgentSessionLifetimeContext
  }
  const tabRecovery: Parameters<typeof createRestartTabHider>[0] = {
    serialize: (id, apply) => read().serialize(id, apply),
    hasUnaccepted: (id) => read().restartResume.hasUnaccepted(id),
    open: (id) => read().conversationDelivery.open(id),
    fence: (id) => structuredAgentSessionConversationFence(read().deps.store, id)
  }
  return {
    tabRecovery,
    reads: createStructuredAgentSessionConversationReads(() => {
      const host = read()
      return {
        deps: host.deps,
        sessions: host.sessions,
        serialize: host.serialize,
        readCommands: host.clientDelivery.readCommandsSettled,
        conversation: (id) => host.lifetimeConversation(id)
      }
    }),
    lifetime,
    attach: (): StructuredAgentSessionAttachContext => {
      const host = read()
      return {
        ...lifetime(),
        subscribers: host.clientDelivery.subscribers,
        tasks: host.tasks,
        reconcileLeases: (id) => host.runtimeState.reconcileLeases(id),
        serialize: host.serialize,
        openProviderChild: host.eventRecovery.openProviderChild,
        openConversation: host.conversationDelivery.open
      }
    }
  }
}
