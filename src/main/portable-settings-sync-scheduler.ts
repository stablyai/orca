import type { PortableSettingsSyncState } from '../shared/portable-settings-sync'

const SETTINGS_SYNC_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const

type RunSync = (
  environmentId: string,
  forceRemoteCheck: boolean
) => Promise<PortableSettingsSyncState>

export class PortableSettingsSyncScheduler {
  private disposed = false
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly queues = new Map<string, Promise<PortableSettingsSyncState>>()

  constructor(
    private readonly runSync: RunSync,
    private readonly onPending: (environmentId: string) => void
  ) {}

  schedule(
    environmentId: string,
    delayMs: number,
    forceRemoteCheck: boolean,
    markPending = true
  ): void {
    if (this.disposed) {
      return
    }
    this.clear(environmentId)
    if (markPending) {
      this.onPending(environmentId)
    }
    const timer = setTimeout(() => {
      this.timers.delete(environmentId)
      void this.enqueue(environmentId, forceRemoteCheck).catch(() => undefined)
    }, delayMs)
    timer.unref?.()
    this.timers.set(environmentId, timer)
  }

  scheduleRetry(environmentId: string, retryAttempt: number): void {
    const delay =
      SETTINGS_SYNC_RETRY_DELAYS_MS[
        Math.min(retryAttempt, SETTINGS_SYNC_RETRY_DELAYS_MS.length - 1)
      ]
    this.schedule(environmentId, delay, true, false)
  }

  enqueue(environmentId: string, forceRemoteCheck: boolean): Promise<PortableSettingsSyncState> {
    const previous = this.queues.get(environmentId)
    const next = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() =>
      this.runSync(environmentId, forceRemoteCheck)
    )
    this.queues.set(environmentId, next)
    const cleanup = (): void => {
      if (this.queues.get(environmentId) === next) {
        this.queues.delete(environmentId)
      }
    }
    void next.then(cleanup, cleanup)
    return next
  }

  clear(environmentId: string): void {
    const timer = this.timers.get(environmentId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(environmentId)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
  }
}
