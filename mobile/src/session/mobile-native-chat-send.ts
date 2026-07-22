import type { RpcClient } from '../transport/rpc-client'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { isTerminalSendRpcAccepted } from '../terminal/terminal-send-rpc-response'

type MobileTerminalClient = {
  id: string
  type: 'mobile'
}

type MobileNativeChatSendArgs = {
  client: RpcClient
  terminal: string
  text: string
  enter?: boolean
  mobileClient?: MobileTerminalClient
}

/** 'unknown' = the RPC failed after the request hit the wire (relay drop or
 *  response timeout) — the desktop may have delivered the text and only the ack
 *  was lost, so callers must not present it as a definite send failure. */
export type MobileNativeChatSendOutcome = 'accepted' | 'rejected' | 'unknown'

export async function sendMobileNativeChatMessageWithOutcome(
  args: MobileNativeChatSendArgs
): Promise<MobileNativeChatSendOutcome> {
  try {
    const response = await args.client.sendRequest('terminal.send', {
      terminal: args.terminal,
      text: args.text,
      enter: args.enter ?? true,
      ...(args.mobileClient ? { client: args.mobileClient } : {})
    })
    return isTerminalSendRpcAccepted(response) ? 'accepted' : 'rejected'
  } catch (error) {
    return isRpcDeliveryUnknown(error) ? 'unknown' : 'rejected'
  }
}

export async function sendMobileNativeChatMessage(
  args: MobileNativeChatSendArgs
): Promise<boolean> {
  return (await sendMobileNativeChatMessageWithOutcome(args)) === 'accepted'
}
