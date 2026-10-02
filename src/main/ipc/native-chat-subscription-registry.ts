import type { WebContents } from 'electron'
import type { NativeChatTranscriptSubscription } from '../native-chat/transcript-watch-contract'
import { abortWhenRendererGone } from './renderer-lifetime-abort'

export type PendingNativeChatSubscription = { controller: AbortController }
export const liveNativeChatSubscriptions = new Map<
  number,
  Map<string, { subscription: NativeChatTranscriptSubscription }>
>()
const pendingSubscriptions = new Map<number, Map<string, PendingNativeChatSubscription>>()
const senderLifetimes = new Map<number, ReturnType<typeof abortWhenRendererGone>>()

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
  const lifetime = senderLifetimes.get(senderId)
  senderLifetimes.delete(senderId)
  lifetime?.dispose()
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

export function registerNativeChatSenderCleanup(sender: WebContents): AbortSignal {
  const existing = senderLifetimes.get(sender.id)
  if (existing) {
    return existing.signal
  }
  const lifetime = abortWhenRendererGone(sender)
  const onRendererGone = (): void => teardownAllForSender(sender.id)
  senderLifetimes.set(sender.id, {
    signal: lifetime.signal,
    dispose: () => {
      lifetime.signal.removeEventListener('abort', onRendererGone)
      lifetime.dispose()
    }
  })
  lifetime.signal.addEventListener('abort', onRendererGone, { once: true })
  return lifetime.signal
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
  const senderIds = new Set([
    ...senderLifetimes.keys(),
    ...liveNativeChatSubscriptions.keys(),
    ...pendingSubscriptions.keys()
  ])
  for (const senderId of senderIds) {
    teardownAllForSender(senderId)
  }
  pendingSubscriptions.clear()
}

export const getNativeChatSenderCleanupCountForTest = (): number => senderLifetimes.size

export function getNativeChatPendingSubscriptionCountForTest(): number {
  let count = 0
  for (const bySubId of pendingSubscriptions.values()) {
    count += bySubId.size
  }
  return count
}
