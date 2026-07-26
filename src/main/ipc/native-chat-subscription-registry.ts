import type { WebContents } from 'electron'
import type { NativeChatTranscriptSubscription } from '../native-chat/transcript-watch'
import {
  MAX_NATIVE_CHAT_SUBSCRIPTIONS_PER_SENDER,
  MAX_NATIVE_CHAT_SUBSCRIPTIONS_PROCESS_WIDE,
  NativeChatSetupAttemptAdmission
} from './native-chat-ipc-admission'

export class NativeChatSubscriptionRegistry {
  private readonly live = new Map<number, Map<string, NativeChatTranscriptSubscription>>()
  private readonly pending = new Map<number, Map<string, symbol>>()
  private readonly senderCleanups = new Map<
    number,
    { onDestroyed: () => void; sender: WebContents }
  >()
  private readonly setupAttempts = new NativeChatSetupAttemptAdmission()

  canAdmit(senderId: number, subscriptionId: string): boolean {
    if (
      this.live.get(senderId)?.has(subscriptionId) ||
      this.pending.get(senderId)?.has(subscriptionId)
    ) {
      return true
    }
    return (
      this.logicalCount(senderId) < MAX_NATIVE_CHAT_SUBSCRIPTIONS_PER_SENDER &&
      this.logicalCount() < MAX_NATIVE_CHAT_SUBSCRIPTIONS_PROCESS_WIDE
    )
  }

  claimSetup(senderId: number): symbol | null {
    return this.setupAttempts.claim(senderId)
  }

  releaseSetup(senderId: number, token: symbol): void {
    this.setupAttempts.release(senderId, token)
  }

  beginPending(senderId: number, subscriptionId: string): symbol {
    this.teardown(senderId, subscriptionId)
    const token = Symbol(subscriptionId)
    const bySubscription = this.pending.get(senderId) ?? new Map<string, symbol>()
    bySubscription.set(subscriptionId, token)
    this.pending.set(senderId, bySubscription)
    return token
  }

  takePending(senderId: number, subscriptionId: string, token: symbol): boolean {
    const bySubscription = this.pending.get(senderId)
    if (bySubscription?.get(subscriptionId) !== token) {
      return false
    }
    bySubscription.delete(subscriptionId)
    if (bySubscription.size === 0) {
      this.pending.delete(senderId)
    }
    return true
  }

  publish(
    senderId: number,
    subscriptionId: string,
    subscription: NativeChatTranscriptSubscription
  ): void {
    const bySubscription =
      this.live.get(senderId) ?? new Map<string, NativeChatTranscriptSubscription>()
    bySubscription.get(subscriptionId)?.unsubscribe()
    bySubscription.set(subscriptionId, subscription)
    this.live.set(senderId, bySubscription)
  }

  registerSenderCleanup(sender: WebContents): void {
    const existing = this.senderCleanups.get(sender.id)
    if (existing?.sender === sender) {
      return
    }
    if (existing) {
      this.teardownSender(sender.id)
    }
    const onDestroyed = (): void => {
      if (this.senderCleanups.get(sender.id)?.sender === sender) {
        this.teardownSender(sender.id)
      }
    }
    this.senderCleanups.set(sender.id, { onDestroyed, sender })
    sender.once('destroyed', onDestroyed)
  }

  teardown(senderId: number, subscriptionId: string): void {
    const pendingBySubscription = this.pending.get(senderId)
    pendingBySubscription?.delete(subscriptionId)
    if (pendingBySubscription?.size === 0) {
      this.pending.delete(senderId)
    }
    const liveBySubscription = this.live.get(senderId)
    const subscription = liveBySubscription?.get(subscriptionId)
    subscription?.unsubscribe()
    liveBySubscription?.delete(subscriptionId)
    if (liveBySubscription?.size === 0) {
      this.live.delete(senderId)
    }
    this.releaseSenderCleanupIfIdle(senderId)
  }

  releaseSenderCleanupIfIdle(senderId: number): void {
    if (this.live.has(senderId) || this.pending.has(senderId)) {
      return
    }
    this.releaseSenderCleanup(senderId)
  }

  reset(): void {
    const senderIds = new Set([
      ...this.live.keys(),
      ...this.pending.keys(),
      ...this.senderCleanups.keys()
    ])
    for (const senderId of senderIds) {
      this.teardownSender(senderId)
    }
    this.pending.clear()
    this.setupAttempts.reset()
  }

  get cleanupCount(): number {
    return this.senderCleanups.size
  }

  get pendingCount(): number {
    let count = 0
    for (const bySubscription of this.pending.values()) {
      count += bySubscription.size
    }
    return count
  }

  get logicalSubscriptionCount(): number {
    return this.logicalCount()
  }

  get setupAttemptCount(): number {
    return this.setupAttempts.size
  }

  private logicalCount(senderId?: number): number {
    if (senderId !== undefined) {
      return (this.live.get(senderId)?.size ?? 0) + (this.pending.get(senderId)?.size ?? 0)
    }
    let count = 0
    const senderIds = new Set([...this.live.keys(), ...this.pending.keys()])
    for (const id of senderIds) {
      count += this.logicalCount(id)
    }
    return count
  }

  private teardownSender(senderId: number): void {
    this.releaseSenderCleanup(senderId)
    this.pending.delete(senderId)
    const bySubscription = this.live.get(senderId)
    if (!bySubscription) {
      return
    }
    for (const subscription of bySubscription.values()) {
      subscription.unsubscribe()
    }
    this.live.delete(senderId)
  }

  private releaseSenderCleanup(senderId: number): void {
    const cleanup = this.senderCleanups.get(senderId)
    if (!cleanup) {
      return
    }
    this.senderCleanups.delete(senderId)
    cleanup.sender.removeListener('destroyed', cleanup.onDestroyed)
  }
}
