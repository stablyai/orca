import type { MutableRefObject } from 'react'
import type { useMobileNativeChatSession } from './use-mobile-native-chat-session'
import type { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'
import type { useMobileStructuredNativeChatSendBridge } from './use-mobile-structured-native-chat-send-bridge'
import type { resolveMobileNativeChat } from './mobile-native-chat-eligibility'
import type { MobileNativeChatController } from './mobile-native-chat-controller-contract'

/**
 * What the mobile native-chat controller publishes, assembled from the two lanes. Kept out of the
 * controller hook (which is at its file cap) as a plain function: no hooks here, so no call order
 * to preserve, and the "which lane wins this field" ternaries live in one place instead of beside
 * the wiring that produces them.
 *
 * The lane split is `activeChatStructured`: a structured (journal-backed) chat owns the turn
 * status, prompts, sends and queued cards, and the terminal lane's values are the fallback an
 * agent without structured support still uses.
 */
export function buildMobileNativeChatControllerResult(args: {
  isTabChatView: MobileNativeChatController['isTabChatView']
  toggleTabChatView: MobileNativeChatController['toggleTabChatView']
  showNativeChat: boolean
  showNativeChatRef: MutableRefObject<boolean>
  activeChatResolution: ReturnType<typeof resolveMobileNativeChat>
  activeChatStructured: boolean
  nativeChatAgentWorking: boolean
  chatComposerText: string
  setChatComposerText: MobileNativeChatController['setChatComposerText']
  getChatComposerEditGeneration: MobileNativeChatController['getChatComposerEditGeneration']
  chatPending: MobileNativeChatController['chatPending']
  chatImagePreviewsByMessageId: MobileNativeChatController['chatImagePreviewsByMessageId']
  nativeChatSession: ReturnType<typeof useMobileNativeChatSession>
  structuredNativeChat: ReturnType<typeof useMobileStructuredAgentSession>
  nativeChatStreamingText?: string
  nativeChatStreamLive: boolean
  streamScopeKey: string
  legacyNativeChatPermission: MobileNativeChatController['nativeChatPermission']
  legacyQuestion: MobileNativeChatController['nativeChatQuestion']
  nativeChatAskPrompt: MobileNativeChatController['nativeChatAsk']
  showNativeChatAsk: boolean
  nativeChatAskKey: MobileNativeChatController['nativeChatAskKey']
  dismissNativeChatAsk: MobileNativeChatController['dismissNativeChatAsk']
  answerAsk: MobileNativeChatController['handleNativeChatAnswerAsk']
  cancelAsk: MobileNativeChatController['handleNativeChatCancelAsk']
  respondPermission: MobileNativeChatController['handleNativeChatRespondPermission']
  cancelPrompt: NonNullable<MobileNativeChatController['handleNativeChatCancelPrompt']>
  handleNativeChatStop: MobileNativeChatController['handleNativeChatStop']
  nativeChatFilePaths: string[]
  loadNativeChatFiles: MobileNativeChatController['loadNativeChatFiles']
  legacyHandleNativeChatQuestionAnswer: MobileNativeChatController['handleNativeChatQuestionAnswer']
  handleNativeChatSend: MobileNativeChatController['handleNativeChatSend']
  handleNativeChatSendWithOutcome: MobileNativeChatController['handleNativeChatSendWithOutcome']
  structuredNativeChatSend: ReturnType<typeof useMobileStructuredNativeChatSendBridge>
  readSeededLaunchDraft: MobileNativeChatController['readSeededLaunchDraft']
  nativeChatSessionOptions: MobileNativeChatController['nativeChatSessionOptions']
}): MobileNativeChatController {
  const { activeChatStructured, structuredNativeChat } = args
  return {
    isTabChatView: args.isTabChatView,
    toggleTabChatView: args.toggleTabChatView,
    showNativeChat: args.showNativeChat,
    showNativeChatRef: args.showNativeChatRef,
    nativeChatAgent: args.activeChatResolution?.agent ?? null,
    chatComposerText: args.chatComposerText,
    setChatComposerText: args.setChatComposerText,
    getChatComposerEditGeneration: args.getChatComposerEditGeneration,
    chatPending: args.chatPending,
    chatImagePreviewsByMessageId: args.chatImagePreviewsByMessageId,
    nativeChatSession: args.nativeChatSession,
    /** Structured lane: drives the per-turn status row and live tool progress. */
    nativeChatStructured: activeChatStructured,
    nativeChatAgentWorking: args.nativeChatAgentWorking,
    nativeChatTurnIndicator: activeChatStructured ? structuredNativeChat.turnIndicator : null,
    nativeChatWorkingStartedAt: activeChatStructured ? structuredNativeChat.workingStartedAt : null,
    nativeChatSettledTurns: activeChatStructured ? structuredNativeChat.settledTurns : null,
    nativeChatTurnJournal: activeChatStructured ? structuredNativeChat.turnJournal : null,
    nativeChatCanStop: activeChatStructured
      ? structuredNativeChat.turnId !== null
      : args.nativeChatAgentWorking,
    nativeChatStreamingText: args.nativeChatStreamingText,
    nativeChatStreamLive: args.nativeChatStreamLive,
    nativeChatStreamScopeKey: args.streamScopeKey,
    nativeChatPermission: activeChatStructured
      ? structuredNativeChat.permission
      : args.legacyNativeChatPermission,
    nativeChatQuestion: activeChatStructured ? structuredNativeChat.question : args.legacyQuestion,
    nativeChatAsk:
      !activeChatStructured && args.showNativeChatAsk ? args.nativeChatAskPrompt : null,
    nativeChatAskKey: args.nativeChatAskKey,
    dismissNativeChatAsk: args.dismissNativeChatAsk,
    handleNativeChatAnswerAsk: args.answerAsk,
    handleNativeChatCancelAsk: args.cancelAsk,
    // Heuristic/legacy cards have no durable prompt identity, so keep their
    // cancel affordance absent instead of exposing a dead action.
    handleNativeChatCancelPrompt: activeChatStructured ? args.cancelPrompt : undefined,
    handleNativeChatRespondPermission: args.respondPermission,
    handleNativeChatStop: activeChatStructured
      ? structuredNativeChat.cancel
      : args.handleNativeChatStop,
    // The inactive lane's session is starved of identity, so its cards stay empty.
    nativeChatQueued: structuredNativeChat.queued,
    nativeChatFilePaths: args.nativeChatFilePaths,
    loadNativeChatFiles: args.loadNativeChatFiles,
    handleNativeChatQuestionAnswer: activeChatStructured
      ? structuredNativeChat.respondQuestion
      : args.legacyHandleNativeChatQuestionAnswer,
    handleNativeChatSend: activeChatStructured
      ? args.structuredNativeChatSend.send
      : args.handleNativeChatSend,
    handleNativeChatSendWithOutcome: activeChatStructured
      ? args.structuredNativeChatSend.sendWithOutcome
      : args.handleNativeChatSendWithOutcome,
    readSeededLaunchDraft: args.readSeededLaunchDraft,
    nativeChatSessionOptions: args.nativeChatSessionOptions,
    chatProviderSessions: structuredNativeChat.providerSessions
  }
}
