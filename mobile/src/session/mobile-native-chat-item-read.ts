import { createContext } from 'react'
import { z } from 'zod'
import { isAdmissibleAgentJournalRenderItem } from '../../../src/shared/agent-session-journal-schemas'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import type { MobileNativeChatVisualSource } from './mobile-native-chat-visual-read'
import type { MobileNativeChatMessageDetail } from './use-mobile-native-chat-message-detail'

// One chat item whole, for "Show full output" and "Show full message": every other read sends the
// phone a head of long text, and the host keeps the rest.

const itemReplySchema = z.object({
  item: z.custom<AgentJournalRenderItem>(isAdmissibleAgentJournalRenderItem).nullable()
})

const nativeChatItemRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'agentSession.item',
    method: 'agentSession.item',
    acceptance: 'object-result-or-null',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('native-chat-item', itemReplySchema)
  })
)

const READ_TIMEOUT_MS = 30_000

/** Where whole items are read from; null where the host predates `agentSession.item`. */
export const MobileNativeChatItemSourceContext = createContext<
  (MobileNativeChatVisualSource & { messageDetail?: MobileNativeChatMessageDetail | null }) | null
>(null)

/** The item's body as the host keeps it, fitted to a phone frame; null when the host no longer has
 *  it. Rejects when the host could not be asked or answered with an error. */
export async function readMobileNativeChatItem(
  source: MobileNativeChatVisualSource,
  itemId: string
): Promise<AgentJournalRenderItem | null> {
  const response = await nativeChatItemRead.request(
    source.client,
    { sessionId: source.sessionId, itemId },
    { timeoutMs: READ_TIMEOUT_MS, budgetSpansConnect: true }
  )
  const reply = nativeChatItemRead.interpret(response)
  if (reply === null) {
    throw new Error('The host could not read this item.')
  }
  return reply.item
}
