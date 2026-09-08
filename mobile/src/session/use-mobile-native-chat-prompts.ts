import { useMemo } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { MobileNativeChatAgentStatusWithProvider } from './mobile-native-chat-eligibility'
import { parseAskFromStatus, resolveNativeChatAsk } from '../../../src/shared/native-chat-ask'
import { detectAgentPermission, parseApprovalFromStatus } from './mobile-native-chat-permission'
import { parseAgentQuestion } from './mobile-native-chat-question'

export type MobileNativeChatPrompts = {
  permission: ReturnType<typeof detectAgentPermission>
  question: ReturnType<typeof parseAgentQuestion>
  detectedAsk: ReturnType<typeof parseAskFromStatus>
  ask: ReturnType<typeof parseAskFromStatus>
}

/** Derives the prompt cards shown above the composer. */
export function useMobileNativeChatPrompts(args: {
  enabled: boolean
  status: MobileNativeChatAgentStatusWithProvider | null | undefined
  messages: readonly NativeChatMessage[]
  /** True while `messages` is an unsettled read (including the cached list held
   *  across a reconnect). Required: an ask derived from it may already be answered. */
  transcriptLoading: boolean
}): MobileNativeChatPrompts {
  const { enabled, status, messages, transcriptLoading } = args
  const blocked = status?.state === 'waiting' || status?.state === 'blocked'
  const askFromStatus = useMemo(
    () => parseAskFromStatus(status?.interactivePrompt, status?.toolName),
    [status?.interactivePrompt, status?.toolName]
  )
  const resolvedAsk = useMemo(
    () =>
      resolveNativeChatAsk({
        liveAsk: askFromStatus,
        messages,
        transcriptSettled: !transcriptLoading
      }),
    [askFromStatus, transcriptLoading, messages]
  )
  const askFromMessages = askFromStatus ? null : resolvedAsk
  const detectedAsk = askFromStatus ?? askFromMessages
  const visibleAsk = enabled ? ((blocked ? askFromStatus : null) ?? askFromMessages) : null
  const permission = visibleAsk
    ? null
    : blocked && status
      ? (detectAgentPermission({
          state: status.state,
          lastAssistantMessage: status.lastAssistantMessage,
          toolName: status.toolName,
          toolInput: status.toolInput
        }) ?? parseApprovalFromStatus(status.interactivePrompt))
      : null
  const question =
    !visibleAsk && blocked && status && !permission
      ? parseAgentQuestion(status.lastAssistantMessage ?? '')
      : null

  return {
    permission,
    question,
    detectedAsk: enabled ? detectedAsk : null,
    ask: visibleAsk
  }
}
