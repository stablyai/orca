import type { WebContents } from 'electron'
import type { NativeChatTranscriptSubscription } from '../native-chat/transcript-watch'

export type PendingNativeChatSubscription = { controller: AbortController }
export const liveNativeChatSubscriptions = new Map<
  number,
  Map<string, { subscription: NativeChatTranscriptSubscription }>
>()
const pendingSubscriptions = new Map<number, Map<string, PendingNativeChatSubscription>>()
const senderCleanupRegistered = new Set<number>()

export function teardownNativeChatSubscription(senderId: number, subscriptionId: string): void {
  const pendingBySubId = pendingSubscriptions.get(senderId)
  pendingBySubId?.get(subscriptionId)?.controller.abort()
  pendingBySubId?.delete(subscriptionId)
  if (pendingBySubId?.size === 0) {
    pendingSubscriptions.delete(senderId)
  }
  const bySubId = liveNativeChatSubscriptions.get(senderId)
  const live = bySubId?.get(subscriptionId)
  if (!live || !bySubId) {
    return
  }
  live.subscription.unsubscribe()
  bySubId.delete(subscriptionId)
  if (bySubId.size === 0) {
    liveNativeChatSubscriptions.delete(senderId)
  }
}

function teardownAllForSender(senderId: number): void {
  senderCleanupRegistered.delete(senderId)
  for (const pending of pendingSubscriptions.get(senderId)?.values() ?? []) {
    pending.controller.abort()
  }
  pendingSubscriptions.delete(senderId)
  const bySubId = liveNativeChatSubscriptions.get(senderId)
  if (!bySubId) {
    return
  }
  for (const live of bySubId.values()) {
    live.subscription.unsubscribe()
  }
  liveNativeChatSubscriptions.delete(senderId)
}

export function registerNativeChatSenderCleanup(sender: WebContents): void {
  if (senderCleanupRegistered.has(sender.id)) {
    return
  }
  senderCleanupRegistered.add(sender.id)
  sender.once('destroyed', () => teardownAllForSender(sender.id))
}

export function beginPendingNativeChatSubscription(
  senderId: number,
  subscriptionId: string
): PendingNativeChatSubscription {
  teardownNativeChatSubscription(senderId, subscriptionId)
  const pending = { controller: new AbortController() }
  const bySubId =
    pendingSubscriptions.get(senderId) ?? new Map<string, PendingNativeChatSubscription>()
  bySubId.set(subscriptionId, pending)
  pendingSubscriptions.set(senderId, bySubId)
  return pending
}

export function takePendingNativeChatSubscription(
  senderId: number,
  subscriptionId: string,
  pending: PendingNativeChatSubscription
): boolean {
  const bySubId = pendingSubscriptions.get(senderId)
  if (bySubId?.get(subscriptionId) !== pending) {
    return false
  }
  bySubId.delete(subscriptionId)
  if (bySubId.size === 0) {
    pendingSubscriptions.delete(senderId)
  }
  return true
}

export function clearNativeChatSubscriptions(): void {
  const senderIds = new Set([...liveNativeChatSubscriptions.keys(), ...pendingSubscriptions.keys()])
  for (const senderId of senderIds) {
    teardownAllForSender(senderId)
  }
  pendingSubscriptions.clear()
  senderCleanupRegistered.clear()
}

export const getNativeChatSenderCleanupCountForTest = (): number => senderCleanupRegistered.size

export function getNativeChatPendingSubscriptionCountForTest(): number {
  let count = 0
  for (const bySubId of pendingSubscriptions.values()) {
    count += bySubId.size
  }
  return count
}
