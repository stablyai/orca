import { useMemo } from 'react'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  detectAgentPermission,
  parseApprovalFromStatus,
  type MobileChatPermission
} from './mobile-native-chat-permission'
import { parseAgentQuestion, type MobileChatQuestion } from './mobile-native-chat-question'
import { extractPendingAsk, parseAskFromStatus, type AskPrompt } from './mobile-native-chat-ask'

// Derives the native chat's live-status overlays from the active terminal tab's
// agent status: the "working" indicator, the streaming reply preview, and the
// heuristic interactive cards (permission / question / structured Ask). Pure
// derivation extracted from the session route to keep that file under its line
// cap. `interactivePrompt` parsing is memoized so an unchanged prompt yields a
// referentially-stable card (no re-parse on every message tick).

export type MobileNativeChatStatusCards = {
  agentWorking: boolean
  streamingText: string | undefined
  permission: MobileChatPermission | null
  question: MobileChatQuestion | null
  ask: AskPrompt | null
}

export function useMobileNativeChatStatusCards(args: {
  /** True when a native chat view is resolved for the active tab. */
  active: boolean
  /** The active tab's live agent status, or null when not a terminal tab. */
  status: AgentStatusEntry | null | undefined
  /** The live transcript (used for the Ask fallback when no live prompt). */
  messages: NativeChatMessage[]
}): MobileNativeChatStatusCards {
  const { active, status, messages } = args
  const liveStatus = active ? (status ?? null) : null

  const agentWorking = liveStatus?.state === 'working'
  // Surface the agent's in-progress reply (hook preview) as a streaming bubble
  // while it works, before the completed turn is written to the transcript.
  const streamingText = agentWorking ? liveStatus?.lastAssistantMessage : undefined

  const blocked = liveStatus?.state === 'waiting' || liveStatus?.state === 'blocked'
  // Prefer the heuristic permission (it reads the real numbered options from the
  // prompt text) and fall back to the live approval envelope from the agent-status
  // pipe (reliable detection when the prompt text isn't captured).
  const permission =
    (blocked && liveStatus
      ? detectAgentPermission({
          state: liveStatus.state,
          lastAssistantMessage: liveStatus.lastAssistantMessage,
          toolName: liveStatus.toolName,
          toolInput: liveStatus.toolInput
        })
      : null) ?? parseApprovalFromStatus(liveStatus?.interactivePrompt)
  const question =
    blocked && liveStatus && !permission
      ? parseAgentQuestion(liveStatus.lastAssistantMessage ?? '')
      : null

  // A pending AskUserQuestion isn't in the transcript until answered, so prefer
  // the live `interactivePrompt`; memoize so an unchanged prompt is stable.
  const askFromStatus = useMemo(
    () => parseAskFromStatus(liveStatus?.interactivePrompt, liveStatus?.toolName),
    [liveStatus?.interactivePrompt, liveStatus?.toolName]
  )
  // Fall back to the transcript tool-call only when there's no live prompt
  // (covers replays / agents without the live field).
  const askFromMessages = useMemo(
    () => (askFromStatus ? null : extractPendingAsk(messages)),
    [askFromStatus, messages]
  )
  const ask = active ? (askFromStatus ?? askFromMessages) : null

  return { agentWorking, streamingText, permission, question, ask }
}
