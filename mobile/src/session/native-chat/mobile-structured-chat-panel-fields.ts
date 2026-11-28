import type { MobileNativeChatController } from './mobile-native-chat-controller-contract'

type StructuredChatPanels = {
  backgroundTasks: MobileNativeChatController['nativeChatBackgroundTasks']
  contextUsage: MobileNativeChatController['nativeChatContextUsage']
  interruptedContinue: MobileNativeChatController['nativeChatInterruptedContinue']
  threadGoal: MobileNativeChatController['nativeChatThreadGoal']
  mcpPanel: MobileNativeChatController['nativeChatMcpPanel']
  accountUsage: MobileNativeChatController['nativeChatAccountUsage']
  rewind: MobileNativeChatController['nativeChatRewind']
  acceptsImages: boolean
  forkSupport: MobileNativeChatController['nativeChatForkSupport']
  usageLimit: MobileNativeChatController['nativeChatUsageLimit']
}

/** Structured-only panels stay empty while a Hermes terminal chat owns the composer. */
export function mobileStructuredChatPanelFields(
  structured: boolean,
  chat: StructuredChatPanels
): Pick<
  MobileNativeChatController,
  | 'nativeChatBackgroundTasks'
  | 'nativeChatContextUsage'
  | 'nativeChatInterruptedContinue'
  | 'nativeChatThreadGoal'
  | 'nativeChatMcpPanel'
  | 'nativeChatAccountUsage'
  | 'nativeChatRewind'
  | 'nativeChatAcceptsImages'
  | 'nativeChatForkSupport'
  | 'nativeChatUsageLimit'
> {
  return {
    nativeChatBackgroundTasks: structured ? chat.backgroundTasks : null,
    nativeChatContextUsage: structured ? chat.contextUsage : null,
    nativeChatInterruptedContinue: structured ? chat.interruptedContinue : null,
    nativeChatThreadGoal: structured ? chat.threadGoal : null,
    nativeChatMcpPanel: structured ? chat.mcpPanel : null,
    nativeChatAccountUsage: structured ? chat.accountUsage : null,
    nativeChatRewind: structured ? chat.rewind : undefined,
    nativeChatAcceptsImages: !structured || chat.acceptsImages,
    nativeChatForkSupport: structured ? chat.forkSupport : undefined,
    nativeChatUsageLimit: structured ? chat.usageLimit : null
  }
}
