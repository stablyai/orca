import { isWatcherProcessFailure, WatcherProcessFailure } from './parcel-watcher-process-failure'
import { WatcherProcessSupervisor } from './parcel-watcher-process-supervisor'
import type { WatcherProcessSubscribeOptions } from './parcel-watcher-process-protocol'
import type {
  WatcherProcessCallback,
  WatcherProcessHooks,
  WatcherProcessSubscription
} from './parcel-watcher-process-subscription'
import { RuntimeWatcherPendingAssignment } from './runtime-watcher-pending-assignment'
import { RuntimeWatcherPoolLifecycle } from './runtime-watcher-pool-lifecycle'
import { RuntimeWatcherPredecessorBarriers } from './runtime-watcher-predecessor-barriers'
import { RuntimeWatcherQuarantineQueue } from './runtime-watcher-quarantine-queue'
import { handleRuntimeWatcherSubscriptionFailure } from './runtime-watcher-subscription-failure'
import type {
  RuntimeWatcherPoolAssignment,
  RuntimeWatcherPoolSlot,
  RuntimeWatcherPoolSupervisor,
  RuntimeWatcherProcessPoolOptions
} from './runtime-watcher-pool-state'

export type { RuntimeWatcherProcessPoolOptions } from './runtime-watcher-pool-state'

// Why: extra ~50 MiB processes are justified only when quarantine isolates a fault.
const DEFAULT_MAX_SHARED_SUPERVISORS = 1
const DEFAULT_MAX_QUARANTINE_SUPERVISORS = 4

/**
 * Share children while healthy, then move failed roots into bounded quarantine slots.
 */
export class RuntimeWatcherProcessPool {
  private readonly maxSharedSupervisors: number
  private readonly maxQuarantineSupervisors: number
  private readonly createSupervisor: () => RuntimeWatcherPoolSupervisor
  private readonly activeSlots = new Set<RuntimeWatcherPoolSlot>()
  private readonly allSlots = new Set<RuntimeWatcherPoolSlot>()
  private readonly assignments = new Map<string, RuntimeWatcherPoolAssignment>()
  private readonly pendingAssignments = new Map<
    string,
    RuntimeWatcherPendingAssignment<RuntimeWatcherPoolAssignment>
  >()
  private readonly lifecycle = new RuntimeWatcherPoolLifecycle()
  private readonly predecessorBarriers = new RuntimeWatcherPredecessorBarriers()
  private readonly quarantineQueue: RuntimeWatcherQuarantineQueue<RuntimeWatcherPoolSlot>

  constructor(options: RuntimeWatcherProcessPoolOptions = {}) {
    this.maxSharedSupervisors = Math.max(
      1,
      options.maxSharedSupervisors ?? DEFAULT_MAX_SHARED_SUPERVISORS
    )
    this.maxQuarantineSupervisors = Math.max(
      1,
      options.maxQuarantineSupervisors ?? DEFAULT_MAX_QUARANTINE_SUPERVISORS
    )
    this.quarantineQueue = new RuntimeWatcherQuarantineQueue(this.maxQuarantineSupervisors)
    this.createSupervisor = options.createSupervisor ?? (() => new WatcherProcessSupervisor())
  }

  async subscribe(
    dir: string,
    callback: WatcherProcessCallback,
    opts: WatcherProcessSubscribeOptions,
    hooks: WatcherProcessHooks = {}
  ): Promise<WatcherProcessSubscription> {
    this.lifecycle.assertActive()
    const assignmentOrPromise = this.assignmentForRoot(dir, hooks)
    const assignment =
      assignmentOrPromise instanceof Promise ? await assignmentOrPromise : assignmentOrPromise
    this.lifecycle.assertActive()
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
      handleRuntimeWatcherSubscriptionFailure(
        error,
        releaseAssignment,
        (failure) => this.retireSlot(slot, failure),
        () => this.lifecycle.quarantineOrFuse(dir, slot.isolated)
      )
      hooks.onTerminalError?.(error)
    }
    let subscription: WatcherProcessSubscription
    try {
      subscription = await slot.supervisor.subscribe(dir, callback, opts, {
        ...hooks,
        onTerminalError
      })
    } catch (error) {
      handleRuntimeWatcherSubscriptionFailure(
        error,
        releaseAssignment,
        (failure) => this.retireSlot(slot, failure),
        () => this.lifecycle.quarantineOrFuse(dir, slot.isolated)
      )
      throw error
    }

    let unsubscribePromise: Promise<void> | undefined
    return {
      unsubscribe: (): Promise<void> => {
        unsubscribePromise ??= subscription.unsubscribe().then(
          () => releaseAssignment(),
          (error: unknown) => {
            if (isWatcherProcessFailure(error) && error.scope === 'supervisor') {
              this.retireSlot(slot, error)
            } else {
              releaseAssignment()
            }
            throw error
          }
        )
        return unsubscribePromise
      }
    }
  }

  /** Kill every pooled watcher child (production shutdown or test reset). */
  dispose(): void {
    this.lifecycle.dispose()
    // disposeSlot deletes the current slot from allSlots; deleting the
    // in-progress element during Set iteration is safe, so no snapshot needed.
    const disposedError = new WatcherProcessFailure(
      'file watcher supervisor disposed',
      'supervisor',
      'supervisor_disposed'
    )
    this.quarantineQueue.failAll(disposedError)
    for (const slot of this.allSlots) {
      this.disposeSlot(slot)
    }
    this.activeSlots.clear()
    this.allSlots.clear()
    this.assignments.clear()
    this.pendingAssignments.clear()
    this.predecessorBarriers.clear()
  }

  resetForTest(): void {
    this.dispose()
    this.lifecycle.reset()
  }

  forgetRoot(dir: string): void {
    // Physical subscriptions release their assignment through unsubscribe or
    // terminal callbacks. This clears fault history after setup gives up.
    if (!this.assignments.has(dir)) {
      this.quarantineQueue.failRoot(dir)
      this.lifecycle.isolatedRoots.delete(dir)
      this.lifecycle.failedQuarantineRoots.delete(dir)
    }
  }

  private assignmentForRoot(
    dir: string,
    hooks: WatcherProcessHooks
  ): RuntimeWatcherPoolAssignment | Promise<RuntimeWatcherPoolAssignment> {
    this.predecessorBarriers.throwIfRetained(dir)
    if (this.lifecycle.failedQuarantineRoots.has(dir)) {
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
    const pending = this.pendingAssignments.get(dir)
    if (pending) {
      return pending.wait(hooks, (assignment) => assignment.leases++)
    }
    const slot = this.lifecycle.isIsolated(dir) ? this.quarantineSlot(dir) : this.sharedSlot()
    if (slot instanceof Promise) {
      let abandoned = false
      let grantedAssignment: RuntimeWatcherPoolAssignment | undefined
      const basePromise = slot.then((resolvedSlot) => {
        grantedAssignment = this.assignRootToSlot(dir, resolvedSlot, 0)
        if (abandoned) {
          this.releaseRoot(grantedAssignment, dir, false)
        }
        return grantedAssignment
      })
      const pendingAssignment = new RuntimeWatcherPendingAssignment(
        basePromise,
        () => {
          abandoned = true
          if (grantedAssignment) {
            this.releaseRoot(grantedAssignment, dir, false)
          } else {
            this.quarantineQueue.failRoot(dir)
          }
        },
        () => {
          if (this.pendingAssignments.get(dir) === pendingAssignment) {
            this.pendingAssignments.delete(dir)
          }
        }
      )
      this.pendingAssignments.set(dir, pendingAssignment)
      return pendingAssignment.wait(hooks, (assignment) => assignment.leases++)
    }
    return this.assignRootToSlot(dir, slot)
  }

  private assignRootToSlot(
    dir: string,
    slot: RuntimeWatcherPoolSlot,
    leases = 1
  ): RuntimeWatcherPoolAssignment {
    const assignment = { slot, leases }
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

  private quarantineSlot(dir: string): RuntimeWatcherPoolSlot | Promise<RuntimeWatcherPoolSlot> {
    const quarantineSlots = Array.from(this.activeSlots).filter(
      (slot) => slot.isolated && !slot.retired
    )
    if (quarantineSlots.length < this.maxQuarantineSupervisors) {
      return this.createSlot(true)
    }
    return this.quarantineQueue.wait(dir)
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

  private retireSlot(slot: RuntimeWatcherPoolSlot, error: WatcherProcessFailure): void {
    if (slot.retired) {
      return
    }
    slot.retired = true
    this.activeSlots.delete(slot)
    // Why: a replacement cannot safely reacquire a root while the failed child
    // may still own its native watcher handle (notably on Windows).
    this.predecessorBarriers.retain(slot.roots, error)
    for (const root of slot.roots) {
      if (this.assignments.get(root)?.slot === slot) {
        this.assignments.delete(root)
      }
      this.lifecycle.quarantineOrFuse(root, slot.isolated)
    }
    slot.roots.clear()
    // Why: failAllSubscriptions is still iterating callbacks; defer disposal
    // so every logical root receives the supervisor failure first.
    queueMicrotask(() => {
      this.disposeSlot(slot)
      this.drainQuarantineWaiters()
    })
  }

  private releaseRoot(
    assignment: RuntimeWatcherPoolAssignment,
    dir: string,
    releaseLease = true
  ): void {
    if (this.assignments.get(dir) !== assignment) {
      return
    }
    if (releaseLease) {
      assignment.leases--
    }
    if (assignment.leases > 0) {
      return
    }
    const { slot } = assignment
    this.assignments.delete(dir)
    slot.roots.delete(dir)
    this.lifecycle.isolatedRoots.delete(dir)
    if (slot.isolated && slot.roots.size === 0 && !slot.retired) {
      if (!this.quarantineQueue.grantNext(slot)) {
        this.activeSlots.delete(slot)
        this.disposeSlot(slot)
      }
    }
  }

  private drainQuarantineWaiters(): void {
    while (
      this.quarantineQueue.length > 0 &&
      Array.from(this.activeSlots).filter((slot) => slot.isolated && !slot.retired).length <
        this.maxQuarantineSupervisors
    ) {
      this.quarantineQueue.grantNext(this.createSlot(true))
    }
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
