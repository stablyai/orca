import { useMemo } from 'react'
import type { AskPrompt } from '../../../../../src/shared/native-chat/input/native-chat-ask-types'
import { useMobileNativeChatPromptDismiss } from './use-mobile-native-chat-prompt-dismiss'

// Keep answered/collapsed asks across view toggles and remounts until an observed prompt supersedes them.
export function useMobileNativeChatAskDismiss(args: {
  ask: AskPrompt | null
  /** The host wait's start for a status-backed ask; null for a transcript-only one. */
  startedAt: number | null
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
  const card = useMemo(
    () => (args.ask ? { kind: 'question' as const, prompt: args.ask } : null),
    [args.ask]
  )
  const dismiss = useMobileNativeChatPromptDismiss({ ...args, kind: 'ask', card })
  return {
    askKey: dismiss.content,
    showAsk: dismiss.showPrompt,
    collapsedAsk:
      dismiss.collapsed && args.ask
        ? { title: args.ask.questions[0]?.question ?? '', expand: dismiss.expandPrompt }
        : null,
    dismissAsk: dismiss.dismissPrompt,
    collapseAsk: dismiss.collapsePrompt
  }
}
