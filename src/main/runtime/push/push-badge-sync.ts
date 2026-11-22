// Keeps the gateway's copy of this host's unread count current; the gateway sums every host's count into the phone's icon badge.
import { randomUUID } from 'node:crypto'
import type { PushGatewayClient } from './push-gateway-client'
import type { PushDispatcherRegistry } from './push-dispatcher'

// Coalesces a burst of record writes into one recount, under the gateway's per-host event quota.
const BADGE_SETTLE_MS = 1_000
const BADGE_RETRY_MS = 30_000
// An older gateway refuses the badge kind; ask again later instead of on every write.
const BADGE_REFUSED_PAUSE_MS = 60 * 60_000
const MAX_REGISTRATIONS_PER_SEND = 20

type PushBadgeSyncOptions = {
  client: Pick<PushGatewayClient, 'send'>
  registry: PushDispatcherRegistry
  runtime: {
    countUnreadWorkspaces: () => number
    onWorkspaceRecordsWritten: (listener: () => void) => () => void
  }
  /** Test seam: drives the settle and retry delays without real time. */
  schedule?: (run: () => void, delayMs: number) => () => void
}

export class PushBadgeSync {
  private readonly epoch = randomUUID()
  private seq = 0
  /** The count the gateway holds for each registration. */
  private readonly accepted = new Map<string, number>()
  private cancelTimer: (() => void) | null = null
  private running = false
  private dirty = false
  private pausedUntil = 0
  private stopped = true
  private unsubscribe: (() => void) | null = null
  private readonly client: Pick<PushGatewayClient, 'send'>
  private readonly registry: PushDispatcherRegistry
  private readonly runtime: PushBadgeSyncOptions['runtime']
  private readonly schedule: (run: () => void, delayMs: number) => () => void

  constructor(options: PushBadgeSyncOptions) {
    this.client = options.client
    this.registry = options.registry
    this.runtime = options.runtime
    this.schedule =
      options.schedule ??
      ((run, delayMs) => {
        // Why: a pending badge update must never hold the app open at quit.
        const timer = setTimeout(run, delayMs)
        timer.unref?.()
        return () => clearTimeout(timer)
      })
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
    this.cancelTimer?.()
    this.cancelTimer = null
  }

  /** The count or the set of registrations may have changed. */
  request(delayMs = BADGE_SETTLE_MS): void {
    if (this.stopped || this.cancelTimer) {
      return
    }
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null
      void this.flush()
    }, delayMs)
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
      this.request(BADGE_RETRY_MS)
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
      .flatMap(({ pushRegistration: registration }) =>
        registration && registration.expiresAt > now ? [registration.registrationId] : []
      )
    for (const registrationId of this.accepted.keys()) {
      if (!live.includes(registrationId)) {
        this.accepted.delete(registrationId)
      }
    }
    if (live.length === 0) {
      return false
    }
    const count = this.runtime.countUnreadWorkspaces()
    const stale = live.filter((registrationId) => this.accepted.get(registrationId) !== count)
    let retry = false
    for (let start = 0; start < stale.length; start += MAX_REGISTRATIONS_PER_SEND) {
      const result = await this.client.send({
        registrationIds: stale.slice(start, start + MAX_REGISTRATIONS_PER_SEND),
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
    }
    return retry
  }
}
