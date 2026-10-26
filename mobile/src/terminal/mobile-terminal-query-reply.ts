import { isTerminalQueryReply } from '../../../src/shared/terminal-query-reply'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import { terminalInputSend } from './mobile-terminal-operations'

type TerminalSubscriptionRegistry = {
  has: (handle: string) => boolean
}

type MobileTerminalQueryReplyOptions = {
  bytes: string
  client: RpcOperationSender | null
  clientId: string | null
  connected: boolean
  handle: string
  hostSupportsQueryReplyInput: boolean
  subscribedTerminals: TerminalSubscriptionRegistry
}

export function sendMobileTerminalQueryReply({
  bytes,
  client,
  clientId,
  connected,
  handle,
  hostSupportsQueryReplyInput,
  subscribedTerminals
}: MobileTerminalQueryReplyOptions): Promise<boolean> {
  // Subscriptions, including hidden panes, suppress the desktop responder and own replies.
  // Drop on older hosts that strip inputKind, or reply bytes would take the input floor.
  if (
    !client ||
    !connected ||
    !hostSupportsQueryReplyInput ||
    !subscribedTerminals.has(handle) ||
    !isTerminalQueryReply(bytes)
  ) {
    return Promise.resolve(false)
  }

  return terminalInputSend
    .request(client, {
      terminal: handle,
      text: bytes,
      enter: false,
      inputKind: 'query-reply',
      ...(clientId ? { client: { id: clientId, type: 'mobile' as const } } : {})
    })
    .then(
      (reply) => terminalInputSend.interpret(reply) === true,
      () => false
    )
}
