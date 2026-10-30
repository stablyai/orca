import { stat } from 'node:fs'
import { performance } from 'node:perf_hooks'
import type { DaemonAsyncIoHealth } from '../../shared/daemon-async-io-health'

export const DAEMON_ASYNC_IO_TIMEOUT_MS = 5_000
const HEALTH_CACHE_MS = 30_000

/** A timed-out operation remains owned until it completes; polling cannot flood a stuck pool. */
export class DaemonAsyncIoProbe {
  private pending: Promise<DaemonAsyncIoHealth> | null = null
  private healthyUntil = 0

  constructor(
    private readonly probe: (done: () => void) => void = (done) => stat(process.execPath, done),
    private readonly now: () => number = () => performance.now()
  ) {}

  check(): Promise<DaemonAsyncIoHealth> {
    if (this.pending) {
      return this.pending
    }
    if (this.now() < this.healthyUntil) {
      return Promise.resolve({ state: 'healthy', pendingMs: 0 })
    }
    const startedAt = this.now()
    let complete = false
    let settle!: (health: DaemonAsyncIoHealth) => void
    const pending = new Promise<DaemonAsyncIoHealth>((resolve) => {
      settle = resolve
    })
    this.pending = pending
    const timer = setTimeout(() => {
      settle({ state: 'stalled', pendingMs: Math.max(0, this.now() - startedAt) })
    }, DAEMON_ASYNC_IO_TIMEOUT_MS)
    const done = (): void => {
      if (complete) {
        return
      }
      complete = true
      clearTimeout(timer)
      this.pending = null
      this.healthyUntil = this.now() + HEALTH_CACHE_MS
      // Even an errno proves the pool completed work; spawn prerequisites have their own check.
      settle({ state: 'healthy', pendingMs: 0 })
    }
    try {
      this.probe(done)
    } catch (error) {
      clearTimeout(timer)
      this.pending = null
      return Promise.reject(error)
    }
    return pending
  }
}

const daemonAsyncIoProbe = new DaemonAsyncIoProbe()

export function checkDaemonAsyncIo(): Promise<DaemonAsyncIoHealth> {
  return daemonAsyncIoProbe.check()
}
