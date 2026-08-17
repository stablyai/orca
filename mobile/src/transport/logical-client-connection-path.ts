import type { MobileConnectionPath } from './stable-logical-rpc-client'

export class LogicalClientConnectionPath {
  private migration: MobileConnectionPath | null = null
  private recovery: MobileConnectionPath | null = null
  private recoveryAttempt = 0
  private readonly listeners = new Set<() => void>()

  constructor(private readonly isConnected: () => boolean) {}

  pending(): MobileConnectionPath | null {
    return this.isConnected() ? null : (this.migration ?? this.recovery)
  }

  setMigration(path: MobileConnectionPath | null): void {
    this.update(() => {
      this.migration = path
    })
  }

  reconnectAttempt(activeAttempt: number): number {
    return this.pending() === 'relay'
      ? Math.max(activeAttempt, this.recoveryAttempt)
      : activeAttempt
  }

  clearAfterConnected(): void {
    this.migration = null
    this.recovery = null
    this.recoveryAttempt = 0
  }

  setRecovery(path: MobileConnectionPath | null, attempt?: number): void {
    this.update(() => {
      this.recovery = path
      if (path === null) {
        this.recoveryAttempt = 0
      } else if (attempt !== undefined) {
        this.recoveryAttempt = Math.max(0, Math.trunc(attempt))
      }
    })
  }

  setRecoveryAttempt(attempt: number): void {
    this.update(() => {
      this.recoveryAttempt = Math.max(0, Math.trunc(attempt))
    })
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private update(apply: () => void): void {
    const previousPath = this.pending()
    const previousAttempt = this.reconnectAttempt(0)
    apply()
    if (previousPath === this.pending() && previousAttempt === this.reconnectAttempt(0)) {
      return
    }
    for (const listener of this.listeners) {
      listener()
    }
  }
}
