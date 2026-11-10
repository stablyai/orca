import { subscribeSystemPowerLifecycle } from '../../power/system-power-lifecycle'

type SubscribeResume = (onResume: () => void) => () => void

const subscribeResume: SubscribeResume = (onResume) =>
  subscribeSystemPowerLifecycle({ onSuspend: () => {}, onResume })

// A one-shot timer due at a wall-clock time. Node timers run on a clock that stops while the
// machine sleeps, so a relay token renewal due during a sleep would fire that much later after
// wake, after the token's wall-clock expiry: the relay then closes the still-live control 4401.
// On resume, a task already due runs at once.
export class RelayWallClockTimer {
  private timer: ReturnType<typeof setTimeout> | null = null
  private unsubscribe: (() => void) | null = null
  private dueAt = 0
  private task: (() => void) | null = null

  constructor(
    private readonly now: () => number = Date.now,
    private readonly onResume: SubscribeResume = subscribeResume
  ) {}

  schedule(delayMs: number, task: () => void): void {
    this.cancel()
    this.dueAt = this.now() + delayMs
    this.task = task
    this.timer = setTimeout(() => this.fire(), delayMs)
    // The lifecycle reports the current state on subscribe; only later resumes count.
    let subscribed = false
    this.unsubscribe = this.onResume(() => {
      if (subscribed && this.task === task && this.now() >= this.dueAt) {
        this.fire()
      }
    })
    subscribed = true
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.unsubscribe?.()
    this.unsubscribe = null
    this.task = null
  }

  private fire(): void {
    const task = this.task
    this.cancel()
    task?.()
  }
}
