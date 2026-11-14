import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type { MobileNativeChatTab } from '../../../session/native-chat/mobile-native-chat-eligibility'
import { resolveMobileNativeChat } from '../../../session/native-chat/mobile-native-chat-eligibility'
import { storedTabChatTranscriptIdentity } from '../../../session/native-chat/transcript/mobile-native-chat-transcript-store'
import { heldMobileNativeChatTranscript } from '../../../session/native-chat/transcript/mobile-native-chat-transcript-cache'
import { nativeChatSessionPageRead } from '../../../session/native-chat/agent-session/mobile-native-chat-page-read-operations'
import {
  clearMobileNativeChatDisplay,
  mobileNativeChatDisplayBoundary
} from '../../../session/native-chat/transcript/mobile-native-chat-display-clear'
import { nativeChatHookTurnStartedAt } from '../../../../../src/shared/native-chat/native-chat-terminal-turn'

/** Capture the target chat before a slow clear can switch tabs or hosts. Commit only after the terminal clears. */
export async function prepareMobileTerminalChatDisplayClear(args: {
  client: RpcClient
  hostId: string
  worktreeId: string
  tab: MobileNativeChatTab
  transcriptReadable: boolean
}): Promise<(() => Promise<void>) | null> {
  const { client, hostId, worktreeId, tab, transcriptReadable } = args
  const resolution = resolveMobileNativeChat(tab, transcriptReadable)
  const identity = storedTabChatTranscriptIdentity(hostId, worktreeId, tab, transcriptReadable)
  if (!identity || !resolution) {
    return null
  }
  const preview = {
    text: tab.agentStatus?.lastAssistantMessage?.trim() ?? null,
    turnStartedAt: nativeChatHookTurnStartedAt(tab.agentStatus ?? undefined)
  }
  if (!resolution.sessionId) {
    return preview.text ? () => clearMobileNativeChatDisplay(identity, null, preview) : null
  }
  const reply = nativeChatSessionPageRead.interpret(
    await nativeChatSessionPageRead.request(
      client,
      {
        agent: resolution.agent,
        sessionId: resolution.sessionId,
        limit: 1,
        capabilities: { transcriptSourceOrder: 1 },
        ...(resolution.transcriptPath ? { transcriptPath: resolution.transcriptPath } : {})
      },
      { failWhenDisconnected: true }
    )
  )
  if (!reply.accepted) {
    throw new Error('chat_display_clear_unavailable')
  }
  const boundary =
    mobileNativeChatDisplayBoundary(reply.value) ??
    heldMobileNativeChatTranscript(identity)?.messages.at(-1)
  return boundary || preview.text
    ? () => clearMobileNativeChatDisplay(identity, boundary ?? null, preview)
    : null
}
