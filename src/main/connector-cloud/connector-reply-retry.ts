import type { ConnectorFailure } from './connector-cloud-request'
import { deferredAnswerRetryMs, parkPreparedAnswer } from './connector-outbox'

const RETRY_MS = 30_000

/** Retry eligibility within one transport generation. The journal retains the owed bodies. */
export class ConnectorReplyRetry {
  private readonly parked = new Set<string>()
  private readonly deferred = new Set<string>()
  private readonly deferredOrdinary = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private preparedTimer: ReturnType<typeof setTimeout> | undefined
  private attempts = 0

  constructor(private readonly wake: () => void) {}

  get parkedCount(): number {
    return this.parked.size
  }

  holds(id: string): boolean {
    return this.parked.has(id) || this.deferred.has(id) || this.deferredOrdinary.has(id)
  }

  accepted(ids: readonly string[]): void {
    ids.forEach((id) => this.parked.delete(id))
  }

  ordinary(ids: readonly string[] = []): void {
    ids.forEach((id) => this.deferredOrdinary.add(id))
    if (this.timer) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.deferredOrdinary.clear()
      this.wake()
    }, RETRY_MS)
    this.timer.unref?.()
  }

  prepared(ids: readonly string[], failure: ConnectorFailure): void {
    if (parkPreparedAnswer(failure)) {
      ids.forEach((id) => this.parked.add(id))
      return
    }
    ids.forEach((id) => this.deferred.add(id))
    if (this.preparedTimer) {
      return
    }
    this.preparedTimer = setTimeout(
      () => {
        this.preparedTimer = undefined
        this.deferred.clear()
        this.wake()
      },
      deferredAnswerRetryMs(this.attempts++, failure)
    )
    this.preparedTimer.unref?.()
  }

  transportChanged(): void {
    this.parked.clear()
    this.deferred.clear()
    this.deferredOrdinary.clear()
    clearTimeout(this.preparedTimer)
    this.preparedTimer = undefined
    this.attempts = 0
  }

  retire(): void {
    this.transportChanged()
    clearTimeout(this.timer)
    this.timer = undefined
  }
}
