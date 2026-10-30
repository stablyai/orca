import { sleepStructuredAgentSessionWorkspace } from './structured-agent-session-workspace-sleep'
import { flushStructuredAgentSessionHost } from './structured-agent-session-host-teardown'
import type { StructuredAgentSessionLifetimeContext } from './structured-agent-session-host-lifetime'
import type { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type { StructuredAgentSessionClientDelivery } from './structured-agent-session-client-delivery'
import type { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'
import type { StructuredAgentSessionConversationLifetime } from './structured-agent-session-conversation-lifetime'
import type { StructuredAgentSessionConversationDelivery } from './structured-agent-session-host-delivery'
import type { StructuredAgentSessionRestartResume } from './structured-agent-session-restart-resume-host'

type HostShutdownContext = {
  deps: StructuredAgentSessionLifetimeContext['deps']
  sessions: StructuredAgentSessionConversations
  runtimeState: StructuredAgentSessionHostRuntimeState
  tasks: StructuredAgentSessionTaskQueue
  lifetime: StructuredAgentSessionConversationLifetime
  conversationDelivery: StructuredAgentSessionConversationDelivery
  clientDelivery: StructuredAgentSessionClientDelivery
  restartResume: StructuredAgentSessionRestartResume
  lifetimeContext: () => StructuredAgentSessionLifetimeContext & {
    publishStatus: (sessionId: string) => void
    generationEnded: (sessionId: string) => void
  }
  serialize: StructuredAgentSessionTaskQueue['serialize']
}

export function structuredAgentSessionHostShutdown(read: () => HostShutdownContext) {
  return {
    sleepWorkspace: (workspaceId: string, markAsleep?: boolean) => {
      const context = read()
      return sleepStructuredAgentSessionWorkspace(
        {
          deps: context.deps,
          tasks: context.tasks,
          lifetime: context.lifetime,
          sessions: context.sessions,
          // Starts registered after Stop are newer work.
          deliveryRunning: (id) =>
            context.conversationDelivery.loop.isRunning(id) ||
            context.runtimeState.startFlights.has(id),
          childWorkIncomplete: context.clientDelivery.childWorkIncomplete,
          publishRecordNotes: context.clientDelivery.publishRecordNotes
        },
        workspaceId,
        markAsleep
      )
    },
    flushAllStreamedEvents: async (options?: { trigger?: 'quit' | 'update' }): Promise<void> => {
      const context = read()
      await flushStructuredAgentSessionHost({
        ...context.lifetimeContext(),
        idleSweep: context.lifetime,
        tasks: context.tasks,
        restartResume: context.restartResume,
        serialize: context.serialize,
        trigger: options?.trigger ?? 'quit'
      }).finally(() => context.clientDelivery.closeAll())
    }
  }
}
