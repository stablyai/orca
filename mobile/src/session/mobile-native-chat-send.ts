import type { RpcClient } from '../transport/rpc-client'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
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

/** 'unknown' = the RPC failed without proof the request never reached the
 *  desktop (ack loss after a write, or a cutover that cannot tell whether the
 *  frame was written) — callers must not present it as a definite send failure. */
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
    // Why: a logical relay↔direct cutover rejects the in-flight send without
    // knowing whether its frame reached the wire (the desktop may have delivered
    // it), so treat it as delivery-ambiguous like physical ack-loss — never
    // retry (double-send risk) and never a definite "not sent" that would hide
    // a real delivery.
    return isRpcDeliveryUnknown(error) || isLogicalClientCutoverError(error)
      ? 'unknown'
      : 'rejected'
  }
}

export async function sendMobileNativeChatMessage(
  args: MobileNativeChatSendArgs
): Promise<boolean> {
  return (await sendMobileNativeChatMessageWithOutcome(args)) === 'accepted'
}
