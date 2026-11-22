// Keeps the gateway's copy of this host's unread count current; the gateway sums every host's count into the phone's icon badge.
import { randomUUID } from 'node:crypto'
import type { PushGatewayClient } from './push-gateway-client'
import {
  dropDeadPushRegistrations,
  MAX_REGISTRATIONS_PER_SEND,
  type PushDispatcherRegistry
} from './push-dispatcher'

// Coalesces a burst of record writes into one recount, under the gateway's per-host event quota.
const BADGE_SETTLE_MS = 1_000
const BADGE_RETRY_BASE_MS = 30_000
const BADGE_RETRY_MAX_MS = 10 * 60_000
// An older gateway refuses the badge kind; ask again later instead of on every write.
const BADGE_REFUSED_PAUSE_MS = 60 * 60_000

type PushBadgeSyncOptions = {
  client: Pick<PushGatewayClient, 'send'>
  registry: PushDispatcherRegistry
  runtime: {
    countUnreadWorkspaces: () => number
    onWorkspaceRecordsWritten: (listener: () => void) => () => void
  }
}

export class PushBadgeSync {
  private readonly epoch = randomUUID()
  private seq = 0
  /** The count the gateway holds for each registration. */
  private readonly accepted = new Map<string, number>()
  private timer: { cancel: () => void; dueAt: number } | null = null
  private running = false
  private dirty = false
  private retryDelayMs = BADGE_RETRY_BASE_MS
  private pausedUntil = 0
  private stopped = true
  private unsubscribe: (() => void) | null = null
  private readonly client: Pick<PushGatewayClient, 'send'>
  private readonly registry: PushDispatcherRegistry
  private readonly runtime: PushBadgeSyncOptions['runtime']

  constructor(options: PushBadgeSyncOptions) {
    this.client = options.client
    this.registry = options.registry
    this.runtime = options.runtime
  }

  start(): void {
    this.stopped = false
    this.unsubscribe ??= this.runtime.onWorkspaceRecordsWritten(() => this.request())
    this.request()
  }

  stop(): void {
    this.stopped = true
    this.unsubscribe?.()
    this.unsubscribe = null
    this.timer?.cancel()
    this.timer = null
  }

  /** A phone (re)registered: a badge push it missed while offline is gone, so send the count again. */
  noteRegistered(registrationId: string): void {
    this.accepted.delete(registrationId)
    this.request()
  }

  /** The count or the set of registrations may have changed. */
  request(delayMs = BADGE_SETTLE_MS): void {
    const dueAt = Date.now() + delayMs
    // A change preempts a pending retry backoff.
    if (this.stopped || (this.timer && this.timer.dueAt <= dueAt)) {
      return
    }
    this.timer?.cancel()
    const timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, delayMs)
    // Why: a pending badge update must never hold the app open at quit.
    timer.unref?.()
    this.timer = { cancel: () => clearTimeout(timer), dueAt }
  }

  private async flush(): Promise<void> {
    if (this.running) {
      this.dirty = true
      return
    }
    this.running = true
    let retry = false
    try {
      retry = await this.sendChangedCount()
    } catch (error) {
      console.warn('[push] Failed to send the unread badge count:', error)
      retry = true
    } finally {
      this.running = false
    }
    if (this.dirty) {
      this.dirty = false
      this.request()
    } else if (retry) {
      this.request(this.retryDelayMs)
      this.retryDelayMs = Math.min(this.retryDelayMs * 2, BADGE_RETRY_MAX_MS)
    } else {
      this.retryDelayMs = BADGE_RETRY_BASE_MS
    }
  }

  /** Returns true when a registration still lacks the current count and a retry may land it. */
  private async sendChangedCount(): Promise<boolean> {
    const now = Date.now()
    if (this.stopped || now < this.pausedUntil) {
      return false
    }
    const live = this.registry
      .listDevices()
      .flatMap(({ deviceId, pushRegistration: registration }) =>
        registration && registration.expiresAt > now ? [{ deviceId, registration }] : []
      )
    const liveIds = new Set(live.map((target) => target.registration.registrationId))
    for (const registrationId of this.accepted.keys()) {
      if (!liveIds.has(registrationId)) {
        this.accepted.delete(registrationId)
      }
    }
    if (live.length === 0) {
      return false
    }
    const count = this.runtime.countUnreadWorkspaces()
    const stale = live.filter(
      (target) => this.accepted.get(target.registration.registrationId) !== count
    )
    let retry = false
    for (let start = 0; start < stale.length; start += MAX_REGISTRATIONS_PER_SEND) {
      const batch = stale.slice(start, start + MAX_REGISTRATIONS_PER_SEND)
      const result = await this.client.send({
        registrationIds: batch.map((target) => target.registration.registrationId),
        notification: {
          kind: 'badge',
          badge: count,
          expiresAt: now + 300_000,
          sound: false,
          notificationEpoch: this.epoch,
          notificationSeq: this.seq++,
          source: 'agent-task-complete',
          agentState: null,
          title: 'Orca',
          body: ''
        }
      })
      if (!result.ok) {
        if (result.reason === 'rejected') {
          this.pausedUntil = now + BADGE_REFUSED_PAUSE_MS
          return false
        }
        retry = true
        continue
      }
      for (const entry of result.results) {
        if (entry.status === 'queued') {
          this.accepted.set(entry.registrationId, count)
        } else if (entry.status !== 'dead') {
          retry = true
        }
      }
      dropDeadPushRegistrations(this.registry, batch, result.results)
    }
    return retry
  }
}
