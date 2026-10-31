import { createStructuredAgentSessionConversationReads } from './structured-agent-session-conversation-reads'
import type { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type { StructuredAgentSessionLifetimeContext } from './structured-agent-session-host-lifetime'
import { createStructuredAgentSessionHostMutationContext } from './structured-agent-session-host-mutation-wiring'
import type * as lifetime from './structured-agent-session-conversation-lifetime'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type * as hostMutations from './structured-agent-session-host-mutations'
import type * as HostTypes from './structured-agent-session-host-types'
import type { StructuredAgentSessionEventRecovery } from './structured-agent-session-event-recovery'
import type { StructuredAgentSessionClientDelivery } from './structured-agent-session-client-delivery'
import type { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import type * as conversation from './structured-agent-session-host-delivery'
import type { wireStructuredAgentSessionQueuedMessages as wireQueuedMessages } from './structured-agent-session-queued-wiring'
import { sleepStructuredAgentSessionWorkspace } from './structured-agent-session-workspace-sleep'

export abstract class StructuredAgentSessionHostContexts {
  abstract readonly deps: HostTypes.StructuredAgentSessionHostDeps
  protected abstract readonly sessions: StructuredAgentSessionConversations
  protected abstract readonly subscribers: StructuredAgentSessionClientDelivery['subscribers']
  protected abstract readonly tasks: StructuredAgentSessionTaskQueue
  protected abstract readonly runtimeState: StructuredAgentSessionHostRuntimeState
  protected abstract readonly lifetime: lifetime.StructuredAgentSessionConversationLifetime
  protected abstract readonly conversationDelivery: conversation.StructuredAgentSessionConversationDelivery
  protected abstract readonly eventRecovery: StructuredAgentSessionEventRecovery
  protected abstract readonly clientDelivery: StructuredAgentSessionClientDelivery
  protected abstract readonly queued: ReturnType<typeof wireQueuedMessages>
  protected abstract now: () => number
  protected abstract serialize: StructuredAgentSessionTaskQueue['serialize']
  protected readonly reads = createStructuredAgentSessionConversationReads(() => ({
    deps: this.deps,
    sessions: this.sessions,
    serialize: this.serialize,
    readCommands: (id, commandsOnRequest) =>
      this.clientDelivery.readCommandsSettled(id, commandsOnRequest),
    conversation: (id) => this.lifetime.conversation(id),
    adoptOpened: this.conversationDelivery.adoptOpened
  }))
  // Keep inference so publishStatus stays required in the attach-context spread.
  protected lifetimeContext() {
    return {
      deps: this.deps,
      runtimeState: this.runtimeState,
      sessions: this.sessions,
      now: () => this.now(),
      publishStatus: this.clientDelivery.publishStatus,
      generationEnded: this.clientDelivery.publishGenerationEnded,
      wakeDelivery: (sessionId: string) => this.conversationDelivery.loop.wake(sessionId),
      endExitedChild: this.eventRecovery.endExitedChildUnderSerialize
    } satisfies StructuredAgentSessionLifetimeContext
  }

  protected attachContext(): StructuredAgentSessionAttachContext {
    return {
      ...this.lifetimeContext(),
      subscribers: this.subscribers,
      tasks: this.tasks,
      reconcileLeases: (sessionId) => this.runtimeState.reconcileLeases(sessionId),
      waitSwitchPhysical: (sessionId) => this.lifetime.waitSwitchPhysical(sessionId),
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      openProviderChild: this.eventRecovery.openProviderChild,
      openConversation: this.conversationDelivery.open
    }
  }

  /** Stop hidden children too, using one bounded host snapshot. */
  sleepWorkspace = (workspaceId: string, markAsleep?: boolean) =>
    sleepStructuredAgentSessionWorkspace(
      {
        deps: this.deps,
        tasks: this.tasks,
        lifetime: this.lifetime,
        sessions: this.sessions,
        // Starts registered after Stop are newer work.
        deliveryRunning: (id) =>
          this.conversationDelivery.loop.isRunning(id) || this.runtimeState.startFlights.has(id),
        childWorkIncomplete: this.clientDelivery.childWorkIncomplete,
        publishRecordNotes: this.clientDelivery.publishRecordNotes
      },
      workspaceId,
      markAsleep
    )

  protected mutationContext = (): hostMutations.StructuredAgentSessionMutationContext =>
    createStructuredAgentSessionHostMutationContext({
      deps: this.deps,
      sessions: this.sessions,
      subscribers: this.subscribers,
      lifetime: this.lifetime,
      clientDelivery: this.clientDelivery,
      conversationDelivery: this.conversationDelivery,
      queued: this.queued,
      runtimeState: this.runtimeState,
      attachContext: () => this.attachContext(),
      trackProviderOperation: (operation) => this.tasks.trackAttach(operation),
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      now: () => this.now()
    })
}
