import type {
  ChatPairWriteReply,
  ChatPairWriteRequest
} from '../../../src/shared/chat-pair-pending'
import { hasRuntimeRpcErrorCode } from '../../../src/shared/runtime-rpc-error-code'
import type { RuntimeSessionTabChatViewWrite } from '../../../src/shared/runtime-session-contracts'
import { TERMINAL_CHAT_VIEW_RELAY_TIMEOUT_ERROR } from '../../../src/shared/terminal-chat-view-request'
import { HOST_TERMINAL_SURFACE_SEPARATOR } from '../../../src/shared/terminal-surface-id'
import type { TerminalChatPair } from '../../../src/shared/terminal-tab-view-mode'
import type { RpcClient } from '../transport/rpc-client'
import { waitForRpcClientReconnected } from '../transport/rpc-client-reconnect-wait'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { sessionTabChatViewWrite } from './mobile-session-write-operations'

/** One send's whole budget, the wait for a replacement transport included. */
export const CHAT_VIEW_WRITE_BUDGET_MS = 15_000

/**
 * Sends one fenced chat-pair write and reads the reply the pending writer adopts.
 * `hostPair` is the pair this phone last accepted for the parent tab, or null once it is gone.
 */
export async function sendMobileChatPairWrite(args: {
  client: RpcClient | null
  worktreeId: string
  parentTabId: string
  request: ChatPairWriteRequest
  write: RuntimeSessionTabChatViewWrite
  hostPair: () => TerminalChatPair | null
}): Promise<ChatPairWriteReply> {
  const { client, request } = args
  const deadline = Date.now() + CHAT_VIEW_WRITE_BUDGET_MS
  if (!client) {
    throw new Error('Not connected')
  }
  // Why: a relay session closed by a drop never comes back, so a resend sent at once burns its
  // budget there; wait for the replacement first, within the same budget.
  if (
    client.getState() !== 'connected' &&
    !(await waitForRpcClientReconnected(client, CHAT_VIEW_WRITE_BUDGET_MS))
  ) {
    throw new Error('Not connected')
  }
  const response = await sessionTabChatViewWrite.request(
    client,
    {
      worktree: `id:${args.worktreeId}`,
      tabId: request.leafId
        ? `${args.parentTabId}${HOST_TERMINAL_SURFACE_SEPARATOR}${request.leafId}`
        : args.parentTabId,
      viewMode: request.viewMode,
      chatViewWrite: args.write
    },
    { timeoutMs: Math.max(1, deadline - Date.now()) }
  )
  // Why the shared matcher: a host that does not know the code sends `runtime_error` with the
  // token as the message. The relay to its desktop timed out, so the write may still land.
  if (
    !response.ok &&
    hasRuntimeRpcErrorCode(response.error, TERMINAL_CHAT_VIEW_RELAY_TIMEOUT_ERROR)
  ) {
    throw markRpcDeliveryUnknown(new Error(response.error.message))
  }
  const { chatView, superseded } = sessionTabChatViewWrite.interpret(response)
  const reply: ChatPairWriteReply = superseded ? { superseded } : {}
  if (!chatView) {
    return reply
  }
  if (chatView.viewMode === undefined) {
    // Why: a view this build cannot read is no failure; adopting the shown host pair retires the
    // overlay at once, so the next snapshot decides.
    const host = args.hostPair()
    return {
      ...reply,
      chatView: { viewMode: host?.viewMode ?? null, chatLeafId: host?.chatLeafId ?? null }
    }
  }
  return { ...reply, chatView: { viewMode: chatView.viewMode, chatLeafId: chatView.chatLeafId } }
}
