import { useMemo } from 'react'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { extractPendingAsk, parseAskFromStatus } from './mobile-native-chat-ask'
import { detectAgentPermission, parseApprovalFromStatus } from './mobile-native-chat-permission'
import { parseAgentQuestion } from './mobile-native-chat-question'

export type MobileNativeChatPrompts = {
  permission: ReturnType<typeof detectAgentPermission>
  question: ReturnType<typeof parseAgentQuestion>
  ask: ReturnType<typeof parseAskFromStatus>
}

/** Derives the prompt cards shown above the composer. */
export function useMobileNativeChatPrompts(args: {
  enabled: boolean
  status: AgentStatusEntry | null | undefined
  messages: readonly NativeChatMessage[]
}): MobileNativeChatPrompts {
  const { enabled, status, messages } = args
  const blocked = status?.state === 'waiting' || status?.state === 'blocked'
  // Both permission paths sit inside the paused gate: an approval envelope can
  // outlive its answer (the host keeps it sticky), so only a waiting/blocked
  // agent may surface it — never a working or done one (STA-3144).
  const permission =
    blocked && status
      ? (detectAgentPermission({
          state: status.state,
          lastAssistantMessage: status.lastAssistantMessage,
          toolName: status.toolName,
          toolInput: status.toolInput
        }) ?? parseApprovalFromStatus(status.interactivePrompt))
      : null
  const question =
    blocked && status && !permission ? parseAgentQuestion(status.lastAssistantMessage ?? '') : null
  const askFromStatus = useMemo(
    () => parseAskFromStatus(status?.interactivePrompt, status?.toolName),
    [status?.interactivePrompt, status?.toolName]
  )
  const askFromMessages = useMemo(
    () => (askFromStatus ? null : extractPendingAsk(messages)),
    [askFromStatus, messages]
  )

  return {
    permission,
    question,
    ask: enabled ? (askFromStatus ?? askFromMessages) : null
  }
}
