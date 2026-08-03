import type { RpcClient } from '../transport/rpc-client'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import { isTerminalSendRpcAccepted } from '../terminal/terminal-send-rpc-response'

type MobileTerminalClient = {
  id: string
  type: 'mobile'
}

// Why: Ctrl+U kills the TUI's current input line (desktop native chat sends the
// same byte before its body), so a launch-context prefill parked there cannot
// concatenate with a mobile chat message. The host writes text bytes verbatim.
//
// One Ctrl+U clears ONE logical line, which is all this prefix can do. A parked
// launch draft is routinely multi-line (every Linear block is); callers that know
// one is parked must call clearMobileNativeChatInput FIRST — see
// src/shared/agent-tui-input-clear.ts for the measured 2N-1 law.
const CLEAR_UNSUBMITTED_INPUT = '\x15'

type MobileNativeChatSendArgs = {
  client: RpcClient
  terminal: string
  text: string
  enter?: boolean
  clearInputFirst?: boolean
  /** Exact host launch draft this submitting write resolves when accepted. */
  resolvedLaunchDraft?: { text: string; createdAt: number }
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
        text: args.clearInputFirst ? `${CLEAR_UNSUBMITTED_INPUT}${args.text}` : args.text,
        enter: args.enter ?? true,
        ...(args.resolvedLaunchDraft ? { resolvedLaunchDraft: args.resolvedLaunchDraft } : {}),
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

/**
 * Clear the agent's input line as its OWN write, before any body.
 *
 * Why not prefix it onto the body write: a multi-line clear burst bundled into
 * the same `terminal.send` as the text reached the agent as LITERAL Ctrl+U
 * characters — the draft survived and the burst landed in the middle of the
 * message (observed live: draft + 21 literal \x15 + body). A standalone write is
 * the shape the image paste has always used, and it clears as intended.
 */
export async function clearMobileNativeChatInput(args: {
  client: RpcClient
  terminal: string
  clearInput: string
  mobileClient?: MobileTerminalClient
  deadline?: number
}): Promise<boolean> {
  const timeoutMs =
    args.deadline === undefined ? MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS : args.deadline - Date.now()
  if (timeoutMs < MOBILE_NATIVE_CHAT_MIN_WRITE_TIMEOUT_MS) {
    return false
  }
  try {
    const response = await args.client.sendRequest(
      'terminal.send',
      {
        terminal: args.terminal,
        text: args.clearInput,
        enter: false,
        ...(args.mobileClient ? { client: args.mobileClient } : {})
      },
      { timeoutMs, budgetSpansConnect: true }
    )
    return isTerminalSendRpcAccepted(response)
  } catch {
    // A failed clear must not send the body on top of an uncleared line.
    return false
  }
}
