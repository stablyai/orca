import { useMemo } from 'react'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import type { AskPrompt } from '../../../src/shared/native-chat-ask'
import type { NativeChatAsyncQuestionsView } from '../../../src/shared/native-chat-async-questions'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { resolveNativeChatTranscriptAgent } from '../../../src/shared/native-chat-agent-support'
import { resolveTerminalChatDecision } from '../../../src/shared/native-chat-pending-decision'
import {
  detectAgentPermission,
  mobileApprovalFromDecision,
  type MobileChatPermission
} from './mobile-native-chat-permission'
import { parseAgentQuestion } from './mobile-native-chat-question'
import { projectUnsupportedDecision } from './mobile-native-chat-unsupported-decision'

export type MobileNativeChatPrompts = {
  permission: MobileChatPermission | null
  question: ReturnType<typeof parseAgentQuestion>
  detectedAsk: AskPrompt | null
  ask: AskPrompt | null
}

/** Derives the prompt cards shown above the composer from the shared resolver; the phone
 *  keeps only presentation and its prose guesses, which run only when the resolver allows. */
export function useMobileNativeChatPrompts(args: {
  enabled: boolean
  status: AgentStatusEntry | null | undefined
  messages: readonly NativeChatMessage[]
  /** True while `messages` is an unsettled read (including the cached list held
   *  across a reconnect). Required: an ask derived from it may already be answered. */
  transcriptLoading: boolean
  /** Host-derived async questions; a pending or non-empty set suppresses the guesses. */
  asyncQuestions: NativeChatAsyncQuestionsView
}): MobileNativeChatPrompts {
  const { enabled, status, messages, transcriptLoading, asyncQuestions } = args
  const state = status?.state
  const interactivePrompt = status?.interactivePrompt
  const toolName = status?.toolName
  // Keyed on what the resolver reads, so other status updates don't re-run the transcript scan.
  const resolved = useMemo(
    () =>
      resolveTerminalChatDecision({
        status: { state, interactivePrompt, toolName },
        messages,
        transcriptSettled: !transcriptLoading,
        asyncQuestions
      }),
    [state, interactivePrompt, toolName, messages, transcriptLoading, asyncQuestions]
  )
  const { decision, heuristicsAllowed } = resolved
  const openCode = resolveNativeChatTranscriptAgent(status?.agentType) === 'opencode'
  const permission =
    decision?.kind === 'approval'
      ? mobileApprovalFromDecision(decision, status?.agentType)
      : decision?.kind === 'unsupported'
        ? projectUnsupportedDecision(decision.text)
        : heuristicsAllowed && status && !openCode
          ? detectAgentPermission({
              state: status.state,
              lastAssistantMessage: status.lastAssistantMessage,
              toolName: status.toolName,
              toolInput: status.toolInput
            })
          : null
  const question =
    heuristicsAllowed && status && !permission
      ? parseAgentQuestion(status.lastAssistantMessage ?? '')
      : null
  return {
    permission,
    question,
    detectedAsk: enabled ? resolved.detectedAsk : null,
    ask: enabled && decision?.kind === 'question' ? decision.prompt : null
  }
}
