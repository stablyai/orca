import { sharedPromiseSettlementWaiters } from '../shared/promise-settlement-waiters'
import { throwIfSignalAborted } from '../shared/abort-signal-reason'
import type { GitWorktreeInfo } from '../shared/worktree/types'

export type WorktreeListingObservation = {
  worktrees: GitWorktreeInfo[]
  confirmed: boolean
  isCurrent: () => boolean
}
type Waiter = { isCurrent: () => boolean }
type Observation = {
  scope: object
  route: string
  expiresAt: number
  controller: AbortController
  waiters: Set<Waiter>
  promise: Promise<WorktreeListingObservation>
  completed: boolean
  timer?: ReturnType<typeof setTimeout>
  isCurrent: () => boolean
}

/** Own the complete producer; a request deadline releases only that request's wait. */
export class WorktreeListingObservations {
  private readonly entries = new Map<string, Observation>()

  async observe(options: {
    key: string
    scope: object
    route: string
    ttlMs: number
    reusable: boolean
    signal?: AbortSignal
    isCallerCurrent: () => boolean
    isProducerCurrent: () => boolean
    run: (
      signal: AbortSignal,
      isCurrent: () => boolean
    ) => Promise<{ worktrees: GitWorktreeInfo[]; confirmed: boolean }>
  }): Promise<WorktreeListingObservation> {
    throwIfSignalAborted(options.signal)
    const waiter = { isCurrent: options.isCallerCurrent }
    let entry = this.entries.get(options.key)
    if (
      entry &&
      (entry.scope !== options.scope ||
        entry.route !== options.route ||
        !entry.isCurrent() ||
        entry.expiresAt <= Date.now())
    ) {
      entry.controller.abort()
      this.retire(options.key, entry)
      entry = undefined
    }
    if (!entry) {
      const controller = new AbortController()
      const waiters = new Set<Waiter>([waiter])
      const producerCurrent = (): boolean =>
        !controller.signal.aborted &&
        (!created.completed || created.expiresAt > Date.now()) &&
        options.isProducerCurrent()
      const active = (): boolean => {
        for (const owner of waiters) {
          if (!owner.isCurrent()) {
            waiters.delete(owner)
          }
        }
        if (waiters.size === 0) {
          controller.abort()
        }
        return producerCurrent() && waiters.size > 0
      }
      const isCurrent = (): boolean => (created.completed ? producerCurrent() : active())
      const created: Observation = {
        scope: options.scope,
        route: options.route,
        expiresAt: Infinity,
        controller,
        waiters,
        completed: false,
        isCurrent,
        promise: Promise.resolve().then(async () => {
          if (!active()) {
            throw new Error('Worktree listing superseded')
          }
          const result = await options.run(controller.signal, active)
          if (!active()) {
            throw new Error('Worktree listing superseded')
          }
          created.completed = true
          created.expiresAt = Date.now() + options.ttlMs
          created.timer = setTimeout(() => this.retire(options.key, created), options.ttlMs)
          created.timer.unref()
          return { ...result, isCurrent: producerCurrent }
        })
      }
      entry = created
      this.entries.set(options.key, created)
      void created.promise.then(
        (result) => {
          if (!options.reusable || !result.confirmed) {
            this.retire(options.key, created)
          }
        },
        () => this.retire(options.key, created)
      )
    } else {
      entry.waiters.add(waiter)
    }
    const owned = entry
    try {
      const result = await sharedPromiseSettlementWaiters(owned.promise).wait({
        signal: options.signal
      })
      if (!waiter.isCurrent() || !result.isCurrent()) {
        throw new Error('Worktree listing superseded')
      }
      return result
    } finally {
      owned.waiters.delete(waiter)
      if (!owned.completed && !owned.waiters.size) {
        owned.controller.abort()
        this.retire(options.key, owned)
      }
    }
  }

  private retire(key: string, entry: Observation): void {
    clearTimeout(entry.timer)
    if (this.entries.get(key) === entry) {
      this.entries.delete(key)
    }
  }
}
