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
  /** Shared budget for a whole user action (heal → paste → text, or one selector's
   *  keystroke sequence). Omit to give this write its own full budget. */
  deadline?: number
}

/** 'unknown' = the RPC failed without proof the request never reached the
 *  desktop (ack loss after a write, or a cutover that cannot tell whether the
 *  frame was written) — callers must not present it as a definite send failure. */
export type MobileNativeChatSendOutcome = 'accepted' | 'rejected' | 'unknown'

/** Without an explicit timeout `sendRequest` waits for reconnect indefinitely, and
 *  the composer holds `sending` (send arrow dimmed, no error) for as long as it
 *  pends. Chat writes are interactive: fail them so the user can retry. */
export const MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS = 15_000
export const MOBILE_NATIVE_CHAT_MIN_WRITE_TIMEOUT_MS = 2_000

/** Opens a budget for one user action. Multi-write actions (heal → paste → text, a
 *  paced selector answer) must share one so the composer's `sending` window stays
 *  bounded by MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS instead of multiplying by it. */
export function openMobileNativeChatSendBudget(): number {
  return Date.now() + MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS
}

export async function sendMobileNativeChatMessageWithOutcome(
  args: MobileNativeChatSendArgs
): Promise<MobileNativeChatSendOutcome> {
  const timeoutMs =
    args.deadline === undefined ? MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS : args.deadline - Date.now()
  // Starting an underfunded final write risks delivery followed by a false timeout.
  if (timeoutMs < MOBILE_NATIVE_CHAT_MIN_WRITE_TIMEOUT_MS) {
    return 'rejected'
  }
  try {
    const response = await args.client.sendRequest(
      'terminal.send',
      {
        terminal: args.terminal,
        text: args.text,
        enter: args.enter ?? true,
        ...(args.mobileClient ? { client: args.mobileClient } : {})
      },
      // The budget covers this whole write, reconnect wait included — a chat send
      // that spends its ceiling waiting to connect and then starts a fresh clock
      // pins the composer for twice as long.
      { timeoutMs, budgetSpansConnect: true }
    )
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
