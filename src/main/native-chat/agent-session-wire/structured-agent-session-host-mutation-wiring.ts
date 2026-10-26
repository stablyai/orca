import * as agentStart from './structured-agent-session-agent-start'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { StructuredAgentSessionClientDelivery } from './structured-agent-session-client-delivery'
import type { StructuredAgentSessionConversationLifetime } from './structured-agent-session-conversation-lifetime'
import type { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import type * as conversation from './structured-agent-session-host-delivery'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import type { wireStructuredAgentSessionQueuedMessages } from './structured-agent-session-queued-wiring'

type Inputs = {
  deps: StructuredAgentSessionHostDeps
  sessions: StructuredAgentSessionConversations
  subscribers: StructuredAgentSessionClientDelivery['subscribers']
  lifetime: StructuredAgentSessionConversationLifetime
  clientDelivery: StructuredAgentSessionClientDelivery
  conversationDelivery: conversation.StructuredAgentSessionConversationDelivery
  queued: ReturnType<typeof wireStructuredAgentSessionQueuedMessages>
  runtimeState: StructuredAgentSessionHostRuntimeState
  attachContext: () => StructuredAgentSessionAttachContext
  serialize: StructuredAgentSessionMutationContext['serialize']
  now: () => number
}

export function createStructuredAgentSessionHostMutationContext(
  input: Inputs
): StructuredAgentSessionMutationContext {
  return {
    deps: input.deps,
    sessions: input.sessions,
    publish: (sessionId, journal) => input.subscribers.publish(sessionId, journal),
    publishConversationName: (sessionId) => {
      const record = input.deps.store.getRecord(sessionId)
      if (input.deps.conversationNaming && record) {
        input.deps.conversationNaming.publishName(record.location.workspaceId, sessionId)
      } else {
        input.clientDelivery.publishConversationName(sessionId)
      }
    },
    conversation: input.lifetime.conversation,
    readChildWork: input.clientDelivery.readChildWork,
    publishChildWork: input.clientDelivery.publishChildWork,
    publishWorkChanged: (sessionId) => input.clientDelivery.publishGenerationEnded(sessionId),
    captureChildWorkStops: input.clientDelivery.captureChildWorkStops,
    childWorkOpen: input.clientDelivery.childWorkOpen,
    childWorkIncomplete: input.clientDelivery.childWorkIncomplete,
    serialize: input.serialize,
    openConversation: input.conversationDelivery.open,
    claimAgent: (sessionId) => agentStart.claimOperationStart(input.attachContext(), sessionId),
    startFlights: input.runtimeState.startFlights,
    startupAttempts: input.runtimeState.startupAttempts,
    deliveryOrder: input.runtimeState.deliveryOrder,
    joinChildClose: (sessionId) =>
      agentStart.joinClosingStructuredAgentSessionChild(input.attachContext(), sessionId),
    wakeDelivery: (sessionId) => input.conversationDelivery.loop.wake(sessionId),
    stopAgent: (sessionId, ending) => input.lifetime.stopAgent(sessionId, ending),
    wakeQueuedDrain: (sessionId) => input.queued.drain.schedule(sessionId),
    acquireAborts: input.runtimeState.acquireAborts,
    now: input.now
  }
}
