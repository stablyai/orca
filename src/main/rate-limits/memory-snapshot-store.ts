import type { MemorySnapshot, SnapshotAvailability } from '../../shared/memory-snapshot'

export type SnapshotLoadResult<T> = {
  value: T | null
  availability: Extract<SnapshotAvailability, 'ready' | 'missing'>
}

export type SnapshotRefreshFence = {
  generation: number
  isCurrent: () => boolean
}

type SnapshotFailureClassifier = (
  error: unknown
) => Extract<SnapshotAvailability, 'denied' | 'unavailable'>

type SnapshotRefreshFlight<T> = {
  generation: number
  promise: Promise<MemorySnapshot<T>>
}

export class MemorySnapshotStore<T> {
  private value: T | null = null
  private stale = true
  private availability: SnapshotAvailability = 'unavailable'
  private observedAt: number | null = null
  private generation = 0
  private refreshFlight: SnapshotRefreshFlight<T> | null = null

  constructor(private readonly now: () => number = Date.now) {}

  get(): MemorySnapshot<T> {
    return {
      value: this.value,
      stale: this.stale,
      age: this.observedAt === null ? null : Math.max(0, this.now() - this.observedAt),
      availability: this.availability
    }
  }

  getFreshValue(): T | null {
    return this.stale || this.availability !== 'ready' ? null : this.value
  }

  invalidate(): void {
    this.generation += 1
    this.stale = true
    this.availability = 'unavailable'
  }

  publishOwned(result: SnapshotLoadResult<T>): void {
    this.generation += 1
    this.publish(result)
  }

  revoke(): void {
    this.generation += 1
    this.publish({ value: null, availability: 'missing' })
  }

  /**
   * `loader` must always settle — route filesystem work through the deadline-bounded
   * filesystem host. A flight is only cleared by its own completion, so an unbounded
   * loader pins this store for the process lifetime and it never refreshes again.
   */
  async refresh(
    loader: (fence: SnapshotRefreshFence) => Promise<SnapshotLoadResult<T>>,
    classifyFailure: SnapshotFailureClassifier = () => 'unavailable'
  ): Promise<MemorySnapshot<T>> {
    const requestedGeneration = this.generation
    const active = this.refreshFlight
    if (active) {
      const snapshot = await active.promise
      if (requestedGeneration === this.generation && requestedGeneration !== active.generation) {
        return await this.refresh(loader, classifyFailure)
      }
      return snapshot
    }
    const generation = requestedGeneration
    const fence = {
      generation,
      isCurrent: (): boolean => generation === this.generation
    }
    const refresh = (async (): Promise<MemorySnapshot<T>> => {
      try {
        const result = await loader(fence)
        if (fence.isCurrent()) {
          this.publish(result)
        }
      } catch (error) {
        if (fence.isCurrent()) {
          this.stale = true
          this.availability = classifyFailure(error)
        }
      }
      return this.get()
    })()
    const flight = { generation, promise: refresh }
    this.refreshFlight = flight
    try {
      return await refresh
    } finally {
      if (this.refreshFlight === flight) {
        this.refreshFlight = null
      }
    }
  }

  private publish(result: SnapshotLoadResult<T>): void {
    this.value = result.value
    this.stale = false
    this.availability = result.availability
    this.observedAt = this.now()
  }
}

export function classifyFilesystemSnapshotFailure(
  error: unknown
): Extract<SnapshotAvailability, 'denied' | 'unavailable'> {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EACCES' || code === 'EPERM' ? 'denied' : 'unavailable'
}
