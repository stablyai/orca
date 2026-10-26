import { reportWorkerTerminalUserInput } from '../terminal/worker-terminal-takeover-report'
import type { RpcClient } from '../transport/rpc-client'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import { nativeChatTerminalWrite } from './mobile-session-write-operations'
import { typeAgentTuiCommand } from '../../../src/shared/agent-tui-command-typing'
import { readTerminalSendAcknowledgment } from '../../../src/shared/terminal-send-acknowledgment'

export type MobileNativeChatRpcSender = Parameters<typeof nativeChatTerminalWrite.request>[0]

type MobileTerminalClient = {
  id: string
  type: 'mobile'
}

type MobileNativeChatSendArgs = {
  client: RpcClient
  terminal: string
  text: string
  enter?: boolean
  resolvedLaunchDraft?: { text: string; createdAt: number }
  mobileClient?: MobileTerminalClient
  // Share this deadline across all heal/paste/text or selector writes in one user action.
  deadline?: number
  requireWriteSettlement?: true
}

// Unknown delivery must not be called definite failure; structured queued drafts render as cards, not transcript echoes.
export type MobileNativeChatSendOutcome = 'accepted' | 'rejected' | 'unknown' | 'queued'

export type MobileNativeChatWriteOutcome = Exclude<MobileNativeChatSendOutcome, 'queued'>

// Bound reconnect wait so an interactive send cannot keep the composer locked indefinitely.
export const MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS = 15_000
export const MOBILE_NATIVE_CHAT_MIN_WRITE_TIMEOUT_MS = 2_000

// One action gets one budget; multi-write sequences must not multiply the send timeout.
export function openMobileNativeChatSendBudget(): number {
  return Date.now() + MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS
}

export async function sendMobileNativeChatMessageWithOutcome(
  args: MobileNativeChatSendArgs
): Promise<MobileNativeChatWriteOutcome> {
  const timeoutMs =
    args.deadline === undefined ? MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS : args.deadline - Date.now()
  // Starting an underfunded final write risks delivery followed by a false timeout.
  if (timeoutMs < MOBILE_NATIVE_CHAT_MIN_WRITE_TIMEOUT_MS) {
    return 'rejected'
  }
  try {
    const response = await nativeChatTerminalWrite.request(
      args.client,
      {
        terminal: args.terminal,
        text: args.text,
        enter: args.enter ?? true,
        ...(args.requireWriteSettlement ? { requireWriteSettlement: true as const } : {}),
        ...(args.resolvedLaunchDraft ? { resolvedLaunchDraft: args.resolvedLaunchDraft } : {}),
        ...(args.mobileClient ? { client: args.mobileClient } : {})
      },
      // Spend reconnect and write time from one deadline so the composer cannot remain locked for twice its budget.
      { timeoutMs, budgetSpansConnect: true }
    )
    if (args.requireWriteSettlement && response.ok) {
      const acknowledgment = readTerminalSendAcknowledgment(response.result)
      if (acknowledgment === 'unverifiable') {
        return 'unknown'
      }
      if (acknowledgment === 'refused') {
        return 'rejected'
      }
    }
    if (nativeChatTerminalWrite.interpret(response) !== true) {
      return 'rejected'
    }
    reportWorkerTerminalUserInput(args.client, args.terminal)
    return 'accepted'
  } catch (error) {
    // Cutover cannot prove whether the desktop received the frame; report unknown and never retry automatically.
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

export async function typeMobileNativeChatCommandWithOutcome(args: {
  client: RpcClient
  terminal: string
  command: string
  resolvedLaunchDraft?: { text: string; createdAt: number }
  mobileClient?: MobileTerminalClient
  deadline?: number
  requireWriteSettlement?: true
}): Promise<MobileNativeChatWriteOutcome> {
  let writeIndex = 0
  return typeAgentTuiCommand({
    command: args.command,
    write: (key) => {
      const isSubmit = writeIndex === args.command.length + 1
      writeIndex += 1
      return sendMobileNativeChatMessageWithOutcome({
        client: args.client,
        terminal: args.terminal,
        text: key,
        enter: false,
        ...(args.requireWriteSettlement ? { requireWriteSettlement: true as const } : {}),
        ...(isSubmit && args.resolvedLaunchDraft
          ? { resolvedLaunchDraft: args.resolvedLaunchDraft }
          : {}),
        ...(args.mobileClient ? { mobileClient: args.mobileClient } : {}),
        ...(args.deadline === undefined ? {} : { deadline: args.deadline })
      })
    }
  })
}

// Clear in a separate write: prefixing multiline Ctrl+U bursts onto body text was observed to submit literal control bytes and retain the draft.
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
    const response = await nativeChatTerminalWrite.request(
      args.client,
      {
        terminal: args.terminal,
        text: args.clearInput,
        enter: false,
        ...(args.mobileClient ? { client: args.mobileClient } : {})
      },
      { timeoutMs, budgetSpansConnect: true }
    )
    return nativeChatTerminalWrite.interpret(response) === true
  } catch {
    // A failed clear must not send the body on top of an uncleared line.
    return false
  }
}
