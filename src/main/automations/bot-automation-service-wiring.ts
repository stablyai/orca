import type { Store } from '../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { AutomationService } from './automation-service'
import { createBotAutomationDispatcher } from './bot-automation-launch'
import { runtimeBotAutomationSessions } from '../bots/bot-automation-sessions'
import { bindLookAroundToAutomations } from '../bots/bot-look-around-runtime'
import { bindGoogleTriggersToAutomations } from '../google/google-trigger-runtime'
import { runtimeBotRunRefusals, runtimeBotRunResults } from '../bots/bot-run-results'
import { runtimeBotWaits } from '../bots/bot-waits'
import { startBotRunChatCloser } from '../bots/bot-run-chat-close-runtime'
import { runtimeChatHost } from '../external-conversations/external-conversation-chat'

/** The scheduler's bot side: runs that open in a bot's chat, and the alert when one cannot. */
export function botAutomationServiceOptions(runtime: OrcaRuntimeService) {
  return {
    botDispatcher: createBotAutomationDispatcher(
      runtimeBotAutomationSessions(runtime),
      runtimeBotRunResults(runtime),
      {
        adopt: (conversation, chat, text) => {
          const adopted =
            runtime.getExternalConversationSeam()?.adoptRun(conversation, chat, text) ?? false
          if (adopted) {
            // A run's thread is the run's, never a new thread waiting to be opened.
            runtime.markBotThreadSeen(chat.sessionId)
          }
          return adopted
        },
        ownerChat: async (conversation) => {
          const seam = runtime.getExternalConversationSeam()
          const chat =
            seam &&
            (await seam.goneChats.linkedChatOf({ chat: runtimeChatHost(runtime) }, conversation))
          return chat ?? null
        },
        release: (conversation) =>
          runtime.getExternalConversationSeam()?.goneChats.release(conversation)
      }
    ),
    onRunRefused: runtimeBotRunRefusals(runtime)
  }
}

/** Bots' waits, Look around and Google triggers, on the runtime's scheduler. */
export function bindBotAutomations(
  service: AutomationService,
  store: Store,
  runtime: OrcaRuntimeService
): void {
  service.once = runtimeBotWaits(runtime)
  runtime.inAutomationLane = (automationId, operation) =>
    service.runInAutomationLane(automationId, operation)
  bindLookAroundToAutomations(service, runtime)
  runtime.botRunChatCloser ??= startBotRunChatCloser(runtime, store)
  bindGoogleTriggersToAutomations(service, store, runtime)
}
