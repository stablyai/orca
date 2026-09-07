export type HostClientAcquisition = object

export class HostClientAcquisitionRegistry {
  private readonly acquisitions = new Map<string, Set<HostClientAcquisition>>()

  acquire(hostId: string, acquisition: HostClientAcquisition): number {
    let active = this.acquisitions.get(hostId)
    if (!active) {
      active = new Set()
      this.acquisitions.set(hostId, active)
    }
    active.add(acquisition)
    return active.size
  }

  release(hostId: string, acquisition: HostClientAcquisition): number | null {
    const active = this.acquisitions.get(hostId)
    if (!active?.delete(acquisition)) {
      return null
    }
    if (active.size === 0) {
      this.acquisitions.delete(hostId)
    }
    return active.size
  }

  count(hostId: string): number {
    return this.acquisitions.get(hostId)?.size ?? 0
  }

  clear(hostId: string): void {
    this.acquisitions.delete(hostId)
  }

  clearAll(): void {
    this.acquisitions.clear()
  }
}
