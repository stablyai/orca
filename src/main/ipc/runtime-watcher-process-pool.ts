import { isWatcherProcessFailure, WatcherProcessFailure } from './parcel-watcher-process-failure'
import { WatcherProcessSupervisor } from './parcel-watcher-process-supervisor'
import type { WatcherProcessSubscribeOptions } from './parcel-watcher-process-protocol'
import type {
  WatcherProcessCallback,
  WatcherProcessHooks,
  WatcherProcessSubscription
} from './parcel-watcher-process-subscription'

const DEFAULT_MAX_SHARED_SUPERVISORS = 4
const DEFAULT_MAX_QUARANTINE_SUPERVISORS = 4

type WatcherSupervisor = Pick<WatcherProcessSupervisor, 'dispose' | 'subscribe'>

type RuntimeWatcherPoolSlot = {
  supervisor: WatcherSupervisor
  roots: Set<string>
  isolated: boolean
  retired: boolean
  disposed: boolean
}

type RuntimeWatcherPoolAssignment = {
  slot: RuntimeWatcherPoolSlot
  leases: number
}

export type RuntimeWatcherProcessPoolOptions = {
  maxSharedSupervisors?: number
  maxQuarantineSupervisors?: number
  createSupervisor?: () => WatcherSupervisor
}

/**
 * Share a bounded set of watcher children while healthy, then move roots from
 * a failed shard into a separate bounded quarantine pool.
 */
export class RuntimeWatcherProcessPool {
  private readonly maxSharedSupervisors: number
  private readonly maxQuarantineSupervisors: number
  private readonly createSupervisor: () => WatcherSupervisor
  private readonly activeSlots = new Set<RuntimeWatcherPoolSlot>()
  private readonly allSlots = new Set<RuntimeWatcherPoolSlot>()
  private readonly assignments = new Map<string, RuntimeWatcherPoolAssignment>()
  private readonly isolatedRoots = new Set<string>()
  private readonly failedQuarantineRoots = new Set<string>()

  constructor(options: RuntimeWatcherProcessPoolOptions = {}) {
    this.maxSharedSupervisors = Math.max(
      1,
      options.maxSharedSupervisors ?? DEFAULT_MAX_SHARED_SUPERVISORS
    )
    this.maxQuarantineSupervisors = Math.max(
      1,
      options.maxQuarantineSupervisors ?? DEFAULT_MAX_QUARANTINE_SUPERVISORS
    )
    this.createSupervisor = options.createSupervisor ?? (() => new WatcherProcessSupervisor())
  }

  async subscribe(
    dir: string,
    callback: WatcherProcessCallback,
    opts: WatcherProcessSubscribeOptions,
    hooks: WatcherProcessHooks = {}
  ): Promise<WatcherProcessSubscription> {
    const assignment = this.assignmentForRoot(dir)
    const { slot } = assignment
    let assignmentReleased = false
    const releaseAssignment = (): void => {
      if (assignmentReleased) {
        return
      }
      assignmentReleased = true
      this.releaseRoot(assignment, dir)
    }
    const onTerminalError = (error: Error): void => {
      if (isWatcherProcessFailure(error) && error.scope === 'supervisor') {
        this.retireSlot(slot)
      } else {
        this.releaseFailedRoot(assignment, dir, error, releaseAssignment)
      }
      hooks.onTerminalError?.(error)
    }
    let subscription: WatcherProcessSubscription
    try {
      subscription = await slot.supervisor.subscribe(dir, callback, opts, {
        ...hooks,
        onTerminalError
      })
    } catch (error) {
      if (isWatcherProcessFailure(error) && error.scope === 'supervisor') {
        this.retireSlot(slot)
      } else {
        this.releaseFailedRoot(assignment, dir, error, releaseAssignment)
      }
      throw error
    }

    let unsubscribePromise: Promise<void> | undefined
    return {
      unsubscribe: (): Promise<void> => {
        unsubscribePromise ??= subscription.unsubscribe().finally(() => {
          releaseAssignment()
        })
        return unsubscribePromise
      }
    }
  }

  /** Kill every pooled watcher child (production shutdown or test reset). */
  dispose(): void {
    // disposeSlot deletes the current slot from allSlots; deleting the
    // in-progress element during Set iteration is safe, so no snapshot needed.
    for (const slot of this.allSlots) {
      this.disposeSlot(slot)
    }
    this.activeSlots.clear()
    this.allSlots.clear()
    this.assignments.clear()
    this.isolatedRoots.clear()
    this.failedQuarantineRoots.clear()
  }

  resetForTest(): void {
    this.dispose()
  }

  forgetRoot(dir: string): void {
    // Physical subscriptions release their assignment through unsubscribe or
    // terminal callbacks. This clears fault history after setup gives up.
    if (!this.assignments.has(dir)) {
      this.isolatedRoots.delete(dir)
      this.failedQuarantineRoots.delete(dir)
    }
  }

  private assignmentForRoot(dir: string): RuntimeWatcherPoolAssignment {
    if (this.failedQuarantineRoots.has(dir)) {
      throw new WatcherProcessFailure(
        'file watcher process failed again in quarantine',
        'supervisor',
        'supervisor_crash_fuse'
      )
    }
    const assigned = this.assignments.get(dir)
    if (assigned && !assigned.slot.retired) {
      assigned.leases++
      return assigned
    }
    const slot = this.isolatedRoots.has(dir) ? this.quarantineSlot() : this.sharedSlot()
    const assignment = { slot, leases: 1 }
    slot.roots.add(dir)
    this.assignments.set(dir, assignment)
    return assignment
  }

  private sharedSlot(): RuntimeWatcherPoolSlot {
    const sharedSlots = Array.from(this.activeSlots).filter(
      (slot) => !slot.isolated && !slot.retired
    )
    if (sharedSlots.length < this.maxSharedSupervisors) {
      return this.createSlot(false)
    }
    return sharedSlots.reduce((leastLoaded, candidate) =>
      candidate.roots.size < leastLoaded.roots.size ? candidate : leastLoaded
    )
  }

  private quarantineSlot(): RuntimeWatcherPoolSlot {
    const quarantineSlots = Array.from(this.activeSlots).filter(
      (slot) => slot.isolated && !slot.retired
    )
    if (quarantineSlots.length < this.maxQuarantineSupervisors) {
      return this.createSlot(true)
    }
    return quarantineSlots.reduce((leastLoaded, candidate) =>
      candidate.roots.size < leastLoaded.roots.size ? candidate : leastLoaded
    )
  }

  private createSlot(isolated: boolean): RuntimeWatcherPoolSlot {
    const slot: RuntimeWatcherPoolSlot = {
      supervisor: this.createSupervisor(),
      roots: new Set(),
      isolated,
      retired: false,
      disposed: false
    }
    this.activeSlots.add(slot)
    this.allSlots.add(slot)
    return slot
  }

  private retireSlot(slot: RuntimeWatcherPoolSlot): void {
    if (slot.retired) {
      return
    }
    slot.retired = true
    this.activeSlots.delete(slot)
    for (const root of slot.roots) {
      if (this.assignments.get(root)?.slot === slot) {
        this.assignments.delete(root)
      }
      this.quarantineOrFuse(root, slot.isolated)
    }
    slot.roots.clear()
    // Why: failAllSubscriptions is still iterating callbacks; defer disposal
    // so every logical root receives the supervisor failure first.
    queueMicrotask(() => this.disposeSlot(slot))
  }

  private releaseRoot(assignment: RuntimeWatcherPoolAssignment, dir: string): void {
    if (this.assignments.get(dir) !== assignment) {
      return
    }
    assignment.leases--
    if (assignment.leases > 0) {
      return
    }
    const { slot } = assignment
    this.assignments.delete(dir)
    slot.roots.delete(dir)
    this.isolatedRoots.delete(dir)
    if (slot.isolated && slot.roots.size === 0 && !slot.retired) {
      this.activeSlots.delete(slot)
      this.disposeSlot(slot)
    }
  }

  private releaseFailedRoot(
    assignment: RuntimeWatcherPoolAssignment,
    dir: string,
    error: unknown,
    releaseAssignment: () => void
  ): void {
    releaseAssignment()
    if (!isWatcherProcessFailure(error) || error.code !== 'subscribe_timeout') {
      return
    }
    this.quarantineOrFuse(dir, assignment.slot.isolated)
  }

  // Why: one bounded quarantine attempt is the recovery budget per watch
  // lifetime; an already-isolated root that fails again is fused, not re-isolated,
  // so it cannot spawn another child generation.
  private quarantineOrFuse(dir: string, isolated: boolean): void {
    if (isolated) {
      this.isolatedRoots.delete(dir)
      this.failedQuarantineRoots.add(dir)
      return
    }
    this.isolatedRoots.add(dir)
  }

  private disposeSlot(slot: RuntimeWatcherPoolSlot): void {
    if (slot.disposed) {
      return
    }
    slot.disposed = true
    slot.supervisor.dispose()
    this.allSlots.delete(slot)
  }
}
