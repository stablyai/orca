// The ACP-only half of the native-chat IPC surface: prompt, cancel-turn, and
// tool-approval replies. Split from native-chat.ts, which owns the subscription
// registry and is at its size cap; the dependencies are passed in so the
// registry stays a single owner rather than becoming module state in two files.

import { ipcMain } from 'electron'
import {
  isAcpChatSubscription,
  type NativeChatSessionSubscription
} from '../native-chat/source-dispatch'

export type NativeChatAcpIpcDeps = {
  /** Resolve the live subscription a renderer addresses by (senderId, subscriptionId). */
  findLiveSubscription: (
    senderId: number,
    subscriptionId: string
  ) => NativeChatSessionSubscription | null
  /** Answer a pending tool-approval request; `null` optionId is an explicit cancel. */
  respondPermission: (requestId: string, optionId: string | null) => boolean
}

export function registerNativeChatAcpHandlers(deps: NativeChatAcpIpcDeps): void {
  // Why these hang off the subscription rather than a standalone session map:
  // the ACP client is owned by the subscription, so a prompt can only be sent
  // while the chat view that started the agent is still open.
  ipcMain.handle(
    'nativeChat:acpPrompt',
    async (event, args: { subscriptionId: string; text: string }) => {
      const subscription = deps.findLiveSubscription(event.sender.id, args.subscriptionId)
      if (subscription == null || !isAcpChatSubscription(subscription)) {
        throw new Error('No live ACP session for this chat view')
      }
      await subscription.sendPrompt(args.text)
      return true
    }
  )
  ipcMain.on('nativeChat:acpCancelTurn', (event, args: { subscriptionId: string }) => {
    const subscription = deps.findLiveSubscription(event.sender.id, args.subscriptionId)
    if (subscription != null && isAcpChatSubscription(subscription)) {
      subscription.cancelTurn()
    }
  })
  // `optionId: null` is the operator dismissing the card — an explicit cancel,
  // never an implicit allow.
  ipcMain.handle(
    'nativeChat:acpPermissionRespond',
    (_event, args: { requestId: string; optionId: string | null }) =>
      deps.respondPermission(args.requestId, args.optionId)
  )
}
