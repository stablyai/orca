import type { LiveActivityOverviewStore } from './live-activity-overview-store.js'
import type { ApnsClient } from '../providers/apns/apns-client.js'

export class LiveActivityOverviewWorker {
  private timer?: NodeJS.Timeout
  private pending?: Promise<void>
  private stopped = false

  constructor(private readonly store: LiveActivityOverviewStore, private readonly apns: Pick<ApnsClient, 'sendLiveActivity'> | null) {}

  start(): void {
    if (this.timer) return
    this.stopped = false
    this.timer = setInterval(() => { void this.runDue().catch(() => console.warn('[live-activities] Delivery failed')) }, 1000)
    this.timer.unref()
  }

  runDue(): Promise<void> {
    if (this.pending) return this.pending
    this.pending = this.drain().finally(() => { this.pending = undefined })
    return this.pending
  }

  private async drain(): Promise<void> {
    if (!this.apns) { await this.store.prune(); return }
    for (let count = 0; count < 25 && !this.stopped; count++) {
      const claim = await this.store.claim()
      if (!claim) break
      const result = await this.apns.sendLiveActivity(claim.push).catch(() => ({ status: 'error' as const }))
      await this.store.finish(claim, result.status)
    }
    await this.store.prune()
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    this.timer = undefined
    await this.pending
  }
}
