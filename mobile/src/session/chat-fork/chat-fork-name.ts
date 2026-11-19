import { normalizeAgentSessionConversationName } from '../../../../src/shared/agent-session/conversation-naming/agent-session-conversation-name'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { defineRpcOperation, runRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import { sessionWriteUnreadReplySchema } from '../../transport/rpc/rpc-uninterpreted-reply-schemas'
import { translate } from '../../i18n/mobile-i18n'

const renameChat = defineRpcOperation({
  name: 'agentSession.rename-fork',
  method: 'agentSession.rename',
  acceptance: 'success-result-or-skip',
  barrier: 'on-settle',
  read: rpcResultVariant('fork-renamed', sessionWriteUnreadReplySchema)
})

/** The Fork sheet's default name: this chat's name, marked as its fork. */
export function defaultChatForkName(sourceName: string): string {
  return translate('chat.fork.sheet.nameDefault', '{{name}} (Fork)', { name: sourceName })
}

/** Saves the name picked for a new chat fork as its own name; a host too old to store names keeps
 *  the fork's default one. */
export function nameMobileForkedChat(
  client: RpcClient,
  result: { kind: string; sessionId?: string },
  name: string | undefined
): void {
  const normalized = normalizeAgentSessionConversationName(name)
  if (result.kind !== 'created' || !result.sessionId || !normalized) {
    return
  }
  void runRpcOperation(client, renameChat, { sessionId: result.sessionId, name: normalized }).catch(
    () => {
      // The fork is open either way; it keeps the name its host gave it.
    }
  )
}
