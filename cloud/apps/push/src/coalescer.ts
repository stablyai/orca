import { PUSH_LIMITS, type PushNotification } from '@orca-cloud/push-contract'
import { buildPushDelivery, type PushDelivery } from './push-delivery-message.js'

export type CoalescerTimer = { readonly handle: unknown }

export type PushCoalescerOptions = {
  windowMs?: number
  deliver: (delivery: PushDelivery) => Promise<void>
  setTimer?: (callback: () => void, delayMs: number) => CoalescerTimer
  clearTimer?: (timer: CoalescerTimer) => void
  onDeliveryFailed?: (error: unknown) => void
}

type PendingWindow = {
  hostFingerprint: string
  notifications: PushNotification[]
  timer: CoalescerTimer
}

function defaultSetTimer(callback: () => void, delayMs: number): CoalescerTimer {
  const handle = setTimeout(callback, delayMs)
  handle.unref?.()
  return { handle }
}

function defaultClearTimer(timer: CoalescerTimer): void {
  clearTimeout(timer.handle as NodeJS.Timeout)
}

export function summaryBody(notifications: readonly PushNotification[]): string {
  const count = notifications.length
  return notifications.some((notification) => notification.agentState === 'needs-input')
    ? `${count} agents need attention`
    : `${count} updates`
}

// Holds sends per registration for one window so a burst of desktop events
// reaches the phone as a single banner instead of a stack of near-duplicates.
export class PushCoalescer {
  private readonly windows = new Map<string, PendingWindow>()
  private readonly windowMs: number
  private readonly setTimer: (callback: () => void, delayMs: number) => CoalescerTimer
  private readonly clearTimer: (timer: CoalescerTimer) => void

  constructor(private readonly options: PushCoalescerOptions) {
    this.windowMs = options.windowMs ?? PUSH_LIMITS.coalesceWindowMs
    this.setTimer = options.setTimer ?? defaultSetTimer
    this.clearTimer = options.clearTimer ?? defaultClearTimer
  }

  enqueue(input: {
    registrationId: string
    hostFingerprint: string
    notification: PushNotification
  }): void {
    const existing = this.windows.get(input.registrationId)
    if (existing) {
      existing.notifications.push(input.notification)
      return
    }
    this.windows.set(input.registrationId, {
      hostFingerprint: input.hostFingerprint,
      notifications: [input.notification],
      timer: this.setTimer(() => {
        void this.flush(input.registrationId)
      }, this.windowMs)
    })
  }

  pendingCount(registrationId: string): number {
    return this.windows.get(registrationId)?.notifications.length ?? 0
  }

  async flush(registrationId: string): Promise<void> {
    const window = this.windows.get(registrationId)
    if (!window) return
    this.windows.delete(registrationId)
    this.clearTimer(window.timer)
    const latest = window.notifications.at(-1)!
    const coalescedCount = window.notifications.length
    const delivery = buildPushDelivery({
      registrationId,
      hostFingerprint: window.hostFingerprint,
      notification: latest,
      title: coalescedCount > 1 ? 'Orca' : latest.title,
      body: coalescedCount > 1 ? summaryBody(window.notifications) : latest.body,
      coalescedCount
    })
    try {
      await this.options.deliver(delivery)
    } catch (error) {
      this.options.onDeliveryFailed?.(error)
    }
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.windows.keys()].map((id) => this.flush(id)))
  }

  stop(): void {
    for (const window of this.windows.values()) this.clearTimer(window.timer)
    this.windows.clear()
  }
}
