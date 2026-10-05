import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import type { AskPrompt } from '../../../src/shared/native-chat-ask'
import { useMobileNativeChatAskDismiss } from './use-mobile-native-chat-ask-dismiss'
import {
  useMobileNativeChatPrompts,
  type MobileNativeChatPrompts
} from './use-mobile-native-chat-prompts'
import type { MobileNativeChatSession } from './use-mobile-native-chat-session'

/** The terminal lane's blocking cards: the shared resolver's result plus this device's
 *  ask dismissal, whose identity is always the resolver's `detectedAsk`. */
export function useMobileNativeChatDecisionCards(args: {
  enabled: boolean
  status: AgentStatusEntry | null | undefined
  session: Pick<
    MobileNativeChatSession,
    'messages' | 'status' | 'transcriptLoading' | 'asyncQuestions'
  >
  scopeKey: string | null
  sessionKey: string | null
  visible: boolean
}): Pick<MobileNativeChatPrompts, 'permission' | 'question'> & {
  ask: AskPrompt | null
  askKey: string | null
  dismissAsk: () => void
} {
  const { enabled, status, session, scopeKey, sessionKey, visible } = args
  const { permission, question, detectedAsk, ask } = useMobileNativeChatPrompts({
    enabled,
    status,
    messages: session.messages,
    transcriptLoading: session.transcriptLoading,
    asyncQuestions: session.asyncQuestions
  })
  // A never-read transcript cannot prove that a dismissed prompt cleared.
  const transcriptSettled =
    session.status === 'ready' || (session.status === 'error' && session.messages.length > 0)
  const { askKey, showAsk, dismissAsk } = useMobileNativeChatAskDismiss({
    ask,
    detectedAsk,
    scopeKey,
    sessionKey,
    observing: visible && (detectedAsk != null || transcriptSettled)
  })
  return { permission, question, ask: showAsk ? ask : null, askKey, dismissAsk }
}
