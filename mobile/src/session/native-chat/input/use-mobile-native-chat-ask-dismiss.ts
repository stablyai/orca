import { useMemo } from 'react'
import { nativeChatAskDismissKey } from '../../../../../src/shared/native-chat-ask-dismiss-key'
import type { AskPrompt } from '../../../../../src/shared/native-chat-ask-types'
import { useMobileNativeChatPromptDismiss } from './use-mobile-native-chat-prompt-dismiss'

// Keep answered/collapsed asks across view toggles and remounts until an observed prompt supersedes them.
export function useMobileNativeChatAskDismiss(args: {
  ask: AskPrompt | null
  detectedAsk: AskPrompt | null
  scopeKey: string | null
  sessionKey: string | null
  observing: boolean
}): {
  askKey: string | null
  showAsk: boolean
  /** The collapsed ask, shown as a strip above the composer. */
  collapsedAsk: { title: string; expand: () => void } | null
  dismissAsk: () => void
  collapseAsk: () => void
} {
  const askKey = useMemo(() => nativeChatAskDismissKey(args.ask), [args.ask])
  const detectedPromptKey = useMemo(
    () => nativeChatAskDismissKey(args.detectedAsk),
    [args.detectedAsk]
  )
  const dismiss = useMobileNativeChatPromptDismiss({
    ...args,
    kind: 'ask',
    promptKey: askKey,
    detectedPromptKey
  })
  return {
    askKey,
    showAsk: dismiss.showPrompt,
    collapsedAsk:
      dismiss.collapsed && args.ask
        ? { title: args.ask.questions[0]?.question ?? '', expand: dismiss.expandPrompt }
        : null,
    dismissAsk: dismiss.dismissPrompt,
    collapseAsk: dismiss.collapsePrompt
  }
}
