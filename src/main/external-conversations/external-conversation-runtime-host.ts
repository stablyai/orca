// The runtime's own chats, bots and workers, as the conversation seam reaches them.
import { runtimeBotConversations } from '../bots/bot-conversations'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { readSessionWorkers } from '../runtime/rpc/methods/orchestration/worker/session-workers-method'
import { runtimeChatHost } from './external-conversation-chat'
import type { ExternalConversationHost } from './external-conversation-host'

export function runtimeConversationHost(runtime: OrcaRuntimeService): ExternalConversationHost {
  return {
    chat: runtimeChatHost(runtime),
    bots: runtimeBotConversations(runtime),
    // Only workers a turn its thread woke started show there; others stay in Orca.
    workers: {
      read: (sessionId) => readSessionWorkers(runtime, sessionId, { connectorOnly: true })
    }
  }
}
