/** The WSL host statuses the UI reads, published as each changes, and who hears every change. */
import type { WslHostStatus } from '../../shared/wsl-host-types'

export class WslHostStatusBoard {
  private readonly statuses = new Map<string, WslHostStatus>()
  private readonly listeners = new Set<() => void>()

  constructor(private readonly publish: (status: WslHostStatus) => void) {}

  list(): WslHostStatus[] {
    return [...this.statuses.values()]
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  set(status: WslHostStatus): void {
    this.statuses.set(status.environmentId, status)
    this.publish(status)
    this.notify()
  }

  delete(environmentId: string): void {
    this.statuses.delete(environmentId)
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }
}
