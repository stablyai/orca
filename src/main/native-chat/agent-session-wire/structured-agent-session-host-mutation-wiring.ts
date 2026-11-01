import {
  cancelStructuredAgentSessionTurn,
  respondToStructuredAgentSessionPrompt,
  setStructuredAgentSessionOption,
  changeStructuredAgentSessionThreadGoal
} from './structured-agent-session-host-mutations'
import type {
  StructuredAgentSessionCaller,
  StructuredAgentSessionHostDeps
} from './structured-agent-session-host-types'
import {
  readStructuredAgentSessionOptions,
  type StructuredAgentSessionOptionsReader
} from './structured-agent-session-options-read'
import { IN_PROCESS_OPTIONS_READER } from './structured-agent-session-option-observation'
import { settleStructuredAgentSessionLateDispatch } from './structured-agent-session-late-dispatch'
import * as agentStart from './structured-agent-session-agent-start'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { AgentSessionRewindParams } from '../../../shared/agent-session-rewind'
import { rewindStructuredAgentSession } from './structured-agent-session-rewind'
import type { StructuredAgentSessionClientDelivery } from './structured-agent-session-client-delivery'
import type { StructuredAgentSessionConversationLifetime } from './structured-agent-session-conversation-lifetime'
import type { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import type * as conversation from './structured-agent-session-host-delivery'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
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
  trackProviderOperation: NonNullable<
    StructuredAgentSessionMutationContext['trackProviderOperation']
  >
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
    trackProviderOperation: input.trackProviderOperation,
    joinChildClose: (sessionId) =>
      agentStart.joinClosingStructuredAgentSessionChild(input.attachContext(), sessionId),
    wakeDelivery: (sessionId) => input.conversationDelivery.loop.wake(sessionId),
    stopAgent: (sessionId, ending) => input.lifetime.stopAgent(sessionId, ending),
    wakeQueuedDrain: (sessionId) => input.queued.drain.schedule(sessionId),
    acquireAborts: input.runtimeState.acquireAborts,
    now: input.now
  }
}

/** Resolve context per call so moved maps/fences cannot become stale closures. */
export function structuredAgentSessionMutationDelegates(
  context: () => StructuredAgentSessionMutationContext,
  attachContext: () => StructuredAgentSessionAttachContext
) {
  return {
    cancel: (
      caller: StructuredAgentSessionCaller,
      params: Parameters<typeof cancelStructuredAgentSessionTurn>[2]
    ) => cancelStructuredAgentSessionTurn(context(), caller, params),
    respondToPrompt: (
      caller: StructuredAgentSessionCaller,
      params: Parameters<typeof respondToStructuredAgentSessionPrompt>[2]
    ) => respondToStructuredAgentSessionPrompt(context(), caller, params),
    setOption: (
      caller: StructuredAgentSessionCaller,
      params: Parameters<typeof setStructuredAgentSessionOption>[2]
    ) => setStructuredAgentSessionOption(context(), caller, params),
    changeThreadGoal: (
      caller: StructuredAgentSessionCaller,
      params: Parameters<typeof changeStructuredAgentSessionThreadGoal>[2]
    ) => changeStructuredAgentSessionThreadGoal(context(), caller, params),
    rewind: (caller: StructuredAgentSessionCaller, params: AgentSessionRewindParams) =>
      rewindStructuredAgentSession(context(), attachContext(), caller, params),
    // Only in-process readers omit client identity.
    readOptions: (
      sessionId: string,
      reader: StructuredAgentSessionOptionsReader = IN_PROCESS_OPTIONS_READER
    ) => readStructuredAgentSessionOptions(context(), sessionId, reader),
    settleLateDispatch: (input: Parameters<typeof settleStructuredAgentSessionLateDispatch>[1]) =>
      settleStructuredAgentSessionLateDispatch(context(), input)
  }
}
