import { buildPushDelivery } from './push-delivery-message.js'
import type { PushDispatcher } from './push-dispatcher.js'
import type { DurablePushStore } from './durable-push-store.js'
import { WORKER_DRAINS } from './push-worker-concurrency.js'

export class DurablePushWorker {
  private timer?: NodeJS.Timeout
  private readonly drains = new Set<Promise<void>>()
  private stopped = false
  private wakePending = false
  constructor(
    private readonly store: DurablePushStore,
    private readonly dispatcher: PushDispatcher,
    private readonly options: { now?: () => number; onRetry?: () => void } = {}
  ) {}

  start(): void {
    if (this.timer) return
    this.stopped = false
    this.timer = setInterval(() => {
      void this.runDue().catch(warnWorkerFailed)
    }, 1000)
    this.timer.unref()
  }

  // One drain per wake keeps claims O(sends + drains); the poll restores full concurrency.
  wake(): void {
    if (!this.timer || this.stopped) return
    if (this.drains.size >= WORKER_DRAINS) {
      this.wakePending = true
      return
    }
    this.startDrain().catch(warnWorkerFailed)
  }

  async runDue(): Promise<void> {
    if (this.stopped) return
    const started = Array.from({ length: WORKER_DRAINS - this.drains.size }, () =>
      this.startDrain()
    )
    const active = Promise.allSettled(this.drains)
    const failure = (await Promise.allSettled(started)).find(
      (result) => result.status === 'rejected'
    )
    await active
    if (failure?.status === 'rejected') throw failure.reason
  }

  private startDrain(): Promise<void> {
    const drain: Promise<void> = this.drain().finally(() => {
      this.drains.delete(drain)
      // A committed enqueue can arrive after every drain has found an empty queue.
      if (this.wakePending) {
        this.wakePending = false
        this.wake()
      }
    })
    this.drains.add(drain)
    return drain
  }

  private async drain(): Promise<void> {
    for (let count = 0; count < 25 && !this.stopped; count++) {
      const queued = await this.store.claim()
      if (!queued) return
      const delivery = buildPushDelivery({
        expiresAt: queued.expiresAt,
        registrationId: queued.registrationId,
        hostFingerprint: queued.hostFingerprint,
        notification: queued.notification
      })
      if ((this.options.now ?? Date.now)() >= queued.expiresAt) {
        await this.store.finish(queued)
        continue
      }
      const heartbeat = setInterval(() => {
        void this.store.renew(queued).catch(() => {})
      }, 10_000)
      heartbeat.unref()
      try {
        if (queued.attempts > 1) this.options.onRetry?.()
        const outcome = await this.dispatcher.sendOnce(delivery)
        const retryAfterMs =
          outcome.status === 'error' && outcome.retryable
            ? Math.max(
                outcome.retryAfterMs ?? 0,
                Math.min(30_000, 1000 * 2 ** Math.min(queued.attempts, 5))
              )
            : undefined
        await this.store.finish(queued, retryAfterMs)
      } catch {
        await this.store.finish(queued, 5000)
      } finally {
        clearInterval(heartbeat)
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.wakePending = false
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await Promise.allSettled(this.drains)
  }
}

function warnWorkerFailed(): void {
  console.warn(JSON.stringify({ event: 'orca_push_worker_failed' }))
}
