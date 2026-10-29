import type { CloudNotifications } from '@orca-cloud/cloud-database'
import { INBOX_CHANNEL } from './connector-inbox.js'

export type InboxWaiter = { wait(ms: number): Promise<void>; cancel(): void }

// Held polls wait here. One LISTEN per instance; a reconnect wakes everyone to re-read, since
// notifications sent while the listener was down are lost.
export class InboxWaker {
  private readonly waiters = new Map<string, Set<() => void>>()
  private stopListening: (() => Promise<void>) | null = null
  private isDraining = false

  constructor(private readonly notifications: CloudNotifications) {}

  async start(): Promise<void> {
    this.stopListening = await this.notifications.listen(INBOX_CHANNEL, {
      onNotify: (hostId) => this.wake(hostId),
      onReconnect: () => this.wakeAll()
    })
  }

  // Register before reading the inbox, so a change between the read and the wait still wakes it.
  register(hostId: string): InboxWaiter {
    let wake!: () => void
    const woken = new Promise<void>((resolve) => (wake = resolve))
    const waiters = this.waiters.get(hostId) ?? new Set()
    waiters.add(wake)
    this.waiters.set(hostId, waiters)
    const cancel = (): void => {
      waiters.delete(wake)
      if (waiters.size === 0 && this.waiters.get(hostId) === waiters) {
        this.waiters.delete(hostId)
      }
    }
    return {
      wait: async (ms) => {
        let timer: NodeJS.Timeout | undefined
        await Promise.race([woken, new Promise((resolve) => (timer = setTimeout(resolve, ms)))])
        clearTimeout(timer)
        cancel()
      },
      cancel
    }
  }

  // Shutdown: every held poll answers now and tells its machine to reconnect elsewhere.
  drain(): void {
    this.isDraining = true
    this.wakeAll()
  }

  get draining(): boolean {
    return this.isDraining
  }

  async close(): Promise<void> {
    await this.stopListening?.()
  }

  private wake(hostId: string): void {
    for (const wake of this.waiters.get(hostId) ?? []) {
      wake()
    }
  }

  private wakeAll(): void {
    for (const waiters of this.waiters.values()) {
      for (const wake of waiters) {
        wake()
      }
    }
  }
}
