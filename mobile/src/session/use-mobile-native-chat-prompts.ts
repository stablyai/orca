import { useMemo } from 'react'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import { parseAskFromStatus, resolveNativeChatAsk } from '../../../src/shared/native-chat-ask'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { resolveNativeChatTranscriptAgent } from '../../../src/shared/native-chat-agent-support'
import {
  detectAgentPermission,
  parseApprovalFromStatus,
  parseOmpPlanReviewFromStatus
} from './mobile-native-chat-permission'
import { parseAgentQuestion } from './mobile-native-chat-question'
import {
  useMobileStructuredAsyncQuestion,
  type MobileStructuredAskSession
} from './use-mobile-structured-async-question'

export type MobileNativeChatPrompts = {
  permission: ReturnType<typeof detectAgentPermission>
  question: ReturnType<typeof parseAgentQuestion>
  detectedAsk: ReturnType<typeof parseAskFromStatus>
  ask: ReturnType<typeof parseAskFromStatus>
  /** Set in a structured chat, whose ask is answered by a send rather than a terminal write. */
  structuredAnswer: ReturnType<typeof useMobileStructuredAsyncQuestion>['answer']
}

/** Agent-emitted envelopes carry exact options, so they win over the text heuristic. */
function resolveStatusPermission(status: AgentStatusEntry): MobileNativeChatPrompts['permission'] {
  const planReview = parseOmpPlanReviewFromStatus(status.interactivePrompt)
  if (planReview) {
    return planReview
  }
  if (resolveNativeChatTranscriptAgent(status.agentType) === 'opencode') {
    return parseApprovalFromStatus(status.interactivePrompt, status.agentType)
  }
  return (
    detectAgentPermission({
      state: status.state,
      lastAssistantMessage: status.lastAssistantMessage,
      toolName: status.toolName,
      toolInput: status.toolInput
    }) ?? parseApprovalFromStatus(status.interactivePrompt, status.agentType)
  )
}

export function useMobileNativeChatPrompts(args: {
  enabled: boolean
  /** A structured chat reads only its async question here; its journal prompts are its own cards. */
  structured?: MobileStructuredAskSession | null
  status: AgentStatusEntry | null | undefined
  messages: readonly NativeChatMessage[]
  // Unsettled/retained reconnect history may contain answered asks and cannot supply current prompt cards.
  transcriptLoading: boolean
}): MobileNativeChatPrompts {
  const { enabled, structured = null, status, messages, transcriptLoading } = args
  const blocked = status?.state === 'waiting' || status?.state === 'blocked'
  // Sticky approvals outlive their answers; surface them only while waiting/blocked.
  const permission = blocked && status ? resolveStatusPermission(status) : null
  const question =
    blocked && status && !permission ? parseAgentQuestion(status.lastAssistantMessage ?? '') : null
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
  const structuredAsk = useMobileStructuredAsyncQuestion({
    structured,
    messages,
    transcriptLoading
  })
  if (structured) {
    const ask = enabled ? structuredAsk.ask : null
    return {
      permission: null,
      question: null,
      detectedAsk: ask,
      ask,
      structuredAnswer: structuredAsk.answer
    }
  }

  return {
    structuredAnswer: null,
    // Why: a heuristic card read from the same waiting status would answer the Ask's dialog.
    permission: askFromStatus ? null : permission,
    question: askFromStatus ? null : question,
    detectedAsk: enabled ? detectedAsk : null,
    // Gate sticky status questions on pause, but keep transcript asks until tool results arrive because stale status can project done.
    ask: enabled ? ((blocked ? askFromStatus : null) ?? askFromMessages) : null
  }
}
