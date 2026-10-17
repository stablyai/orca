import { PLUGIN_WORKER_REAP_INTERVAL_MS } from '../../shared/plugins/plugin-host-protocol'

/** Tracks reaper sweeps so time the machine spent asleep never counts as worker idleness. */
export class PluginWorkerIdleClock {
  private lastSweepAt: number | null = null
  private windowStartAt = Number.NEGATIVE_INFINITY

  /** Starts the clock at `now` when no sweep has run, so a sleep before the first sweep is still seen. */
  watchFrom(now: number): void {
    this.lastSweepAt ??= now
  }

  /** Records a sweep at `now` and returns when the current idle window began. */
  sweep(now: number): number {
    // Why: a sweep gap well past the interval means the machine slept, and
    // worker timers slept with it, so that wall-clock time isn't idleness.
    if (this.lastSweepAt !== null && now - this.lastSweepAt > 2 * PLUGIN_WORKER_REAP_INTERVAL_MS) {
      this.windowStartAt = now
    }
    this.lastSweepAt = now
    return this.windowStartAt
  }
}
