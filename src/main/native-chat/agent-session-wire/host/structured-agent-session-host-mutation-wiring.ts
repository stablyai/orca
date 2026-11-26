import type { AgentSessionSelectProviderParams } from '../../../../shared/agent-session/lifecycle/records/agent-session-provider-selection'
import { selectStructuredChatProvider } from '../delivery/structured-agent-session-provider-selection'
import {
  cancelStructuredAgentSessionTurn,
  respondToStructuredAgentSessionPrompt,
  setStructuredAgentSessionOption,
  changeStructuredAgentSessionThreadGoal
} from '../operations/structured-agent-session-host-mutations'

import type { StructuredAgentSessionMutationContext } from '../operations/structured-agent-session-mutation-context'
import type {
  StructuredAgentSessionCaller,
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionConversationLifetime
} from './structured-agent-session-host-types'
import { readStructuredAgentSessionOptions } from '../options/structured-agent-session-options-read'

import type { StructuredAgentSessionOptionsReader } from '../options/structured-agent-session-resting-options'
import { IN_PROCESS_OPTIONS_READER } from '../options/structured-agent-session-option-observation'
import { approveStructuredAutoReviewDenial } from '../operations/structured-auto-review-approval'
import { settleStructuredAgentSessionLateDispatch } from '../operations/structured-agent-session-late-dispatch'
import * as agentStart from '../startup/structured-agent-session-agent-start'
import { joinClosingStructuredAgentSessionChild } from '../termination/structured-agent-session-child-close'
import type { StructuredAgentSessionAttachContext } from '../acquisition/structured-agent-session-attach-context'
import type { AgentSessionRewindParams } from '../../../../shared/agent-session/lifecycle/rewind/agent-session-rewind'
import { rewindStructuredAgentSession } from '../rewind/structured-agent-session-rewind'
import type { StructuredAgentSessionClientDelivery } from '../publication/subscribers/structured-agent-session-client-delivery'

import type { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import type * as conversation from '../delivery/structured-agent-session-host-delivery'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type { wireStructuredAgentSessionQueuedMessages } from '../delivery/structured-agent-session-queued-wiring'

type Inputs = {
  deps: StructuredAgentSessionHostDeps
  sessions: StructuredAgentSessionConversations
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
    publish: (sessionId, journal) => input.clientDelivery.subscribers.publish(sessionId, journal),
    afterProviderSelection: (sessionId, journal) => {
      input.clientDelivery.publishStatusAndSettlement(sessionId)
      input.conversationDelivery.afterCommit(sessionId, journal)
    },
    publishConversationName: (sessionId) => {
      const record = input.deps.store.getRecord(sessionId)
      if (input.deps.conversationNaming && record) {
        input.deps.conversationNaming.publishName(record.location.workspaceId, sessionId)
      } else {
        input.clientDelivery.publishConversationName(sessionId)
      }
    },
    clearPromptSuggestion: (sessionId) =>
      input.clientDelivery.subscribers.promptSuggestions.publish(sessionId, null),
    conversation: input.lifetime.conversation,
    readChildWork: input.clientDelivery.readChildWork,
    publishChildWork: (sessionId, evidence) =>
      input.clientDelivery.publishChildWork(
        sessionId,
        evidence,
        input.runtimeState.currentEventSink(sessionId)?.sink
      ),
    publishWorkChanged: (sessionId) => input.clientDelivery.publishGenerationEnded(sessionId),
    sealEventSink: (sessionId) => input.runtimeState.sealEventSink(sessionId),
    captureChildWorkStops: input.clientDelivery.captureChildWorkStops,
    childWorkOpen: input.clientDelivery.childWorkOpen,
    childWorkIncomplete: input.clientDelivery.childWorkIncomplete,
    serialize: input.serialize,
    openConversation: input.conversationDelivery.open,
    claimAgent: (sessionId, callerKey) =>
      agentStart.claimOperationStart(input.attachContext(), sessionId, callerKey),
    startFlights: input.runtimeState.startFlights,
    startupAttempts: input.runtimeState.startupAttempts,
    deliveryOrder: input.runtimeState.deliveryOrder,
    trackProviderOperation: input.trackProviderOperation,
    joinChildClose: (sessionId) =>
      joinClosingStructuredAgentSessionChild(input.attachContext(), sessionId),
    readStopping: input.clientDelivery.readStopping,
    wakeDelivery: (sessionId) => input.conversationDelivery.loop.wake(sessionId),
    stopAgent: (sessionId, ending) => input.lifetime.stopAgent(sessionId, ending),
    wakeQueuedDrain: (sessionId) => input.queued.drain.schedule(sessionId),
    acquireAborts: input.runtimeState.acquireAborts,
    now: input.now
  }
}

/** Resolve context per call so moved maps/fences cannot become stale closures. */
export function sessionMutations(
  context: () => StructuredAgentSessionMutationContext,
  attachContext: () => StructuredAgentSessionAttachContext
) {
  return {
    selectProvider: async (
      params: AgentSessionSelectProviderParams,
      botDefault?: { botId: string; save: () => Promise<void> }
    ) => {
      const mutations = context()
      await mutations.conversation(params.sessionId)
      return mutations.serialize(params.sessionId, async () => {
        const session = mutations.sessions.get(params.sessionId)
        if (!session) {
          throw new Error('agent_session_provider_switch_unavailable')
        }
        const previous = mutations.deps.store.getRecord(params.sessionId)?.selectedProvider
        const result = await selectStructuredChatProvider(
          {
            deps: mutations.deps,
            now: mutations.now
          },
          session,
          params,
          botDefault?.botId
        )
        if (result.status === 'selected') {
          try {
            await botDefault?.save()
          } catch (error) {
            await mutations.deps.store.updateRecord(params.sessionId, {
              kind: 'select-provider',
              selection: previous ?? null,
              now: mutations.now()
            })
            throw error
          }
          if (mutations.deps.store.getRecord(params.sessionId)?.selectedProvider !== previous) {
            mutations.afterProviderSelection?.(params.sessionId, session.journal)
          }
        }
        return result
      })
    },
    cancel: (
      caller: StructuredAgentSessionCaller,
      params: Parameters<typeof cancelStructuredAgentSessionTurn>[2]
    ) => cancelStructuredAgentSessionTurn(context(), caller, params),
    respondToPrompt: (
      caller: StructuredAgentSessionCaller,
      params: Parameters<typeof respondToStructuredAgentSessionPrompt>[2]
    ) => respondToStructuredAgentSessionPrompt(context(), caller, params),
    approveAutoReviewDenial: (sessionId: string, itemId: string) =>
      approveStructuredAutoReviewDenial(context(), sessionId, itemId),
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
