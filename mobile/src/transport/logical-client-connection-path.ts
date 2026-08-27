import type { MobileConnectionPath } from './stable-logical-rpc-client'

export class LogicalClientConnectionPath {
  private migration: MobileConnectionPath | null = null
  private recovery: MobileConnectionPath | null = null
  private recoveryAttempt = 0
  private pairingRejected = false
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

  isPairingRejected(): boolean {
    return this.pairingRejected
  }

  setPairingRejected(rejected: boolean): void {
    this.update(() => {
      this.pairingRejected = rejected
    })
  }

  clearAfterConnected(): void {
    this.migration = null
    this.recovery = null
    this.recoveryAttempt = 0
    // Why: an authenticated session is the desktop accepting this device.
    this.pairingRejected = false
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
    const previousRejected = this.pairingRejected
    apply()
    if (
      previousPath === this.pending() &&
      previousAttempt === this.reconnectAttempt(0) &&
      previousRejected === this.pairingRejected
    ) {
      return
    }
    for (const listener of this.listeners) {
      listener()
    }
  }
}
