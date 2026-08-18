import type { MobileConnectionPath } from './stable-logical-rpc-client'

export class LogicalClientConnectionPath {
  private migration: MobileConnectionPath | null = null
  private recovery: MobileConnectionPath | null = null
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

  clearAfterConnected(): void {
    this.migration = null
    this.recovery = null
  }

  setRecovery(path: MobileConnectionPath | null): void {
    this.update(() => {
      this.recovery = path
    })
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private update(apply: () => void): void {
    const previous = this.pending()
    apply()
    if (previous === this.pending()) {
      return
    }
    for (const listener of this.listeners) {
      listener()
    }
  }
}
