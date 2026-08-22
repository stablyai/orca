import type { SubscriptionRegistration } from '../orca-runtime'

type Cleanup = () => void | Promise<void>

export type SubscriptionRegistryDouble = {
  registerSubscriptionCleanup: (id: string, cleanup: Cleanup, connectionId?: string) => void
  registerOwnedSubscriptionCleanup: (
    id: string,
    cleanup: Cleanup,
    connectionId?: string
  ) => SubscriptionRegistration
  cleanupSubscription: (id: string) => void
  cleanupSubscriptionIfOwnedByConnection: (id: string, connectionId: string | undefined) => boolean
  cleanupSubscriptionsForConnection: (connectionId: string) => void
  /** Test-only inspection; the runtime deliberately exposes no such accessor. */
  peekCleanup: (id: string) => Cleanup | undefined
}

/**
 * Faithful double of the runtime subscription registry (`OrcaRuntimeService`,
 * `registerSubscriptionCleanup` through `cleanupSubscriptionsForConnection`).
 *
 * This mirrors production line-for-line, so it can drift. If you change
 * `registerSubscriptionCleanup`, `cleanupSubscriptionAndWait`,
 * `cleanupOwnedSubscription`, `cleanupSubscriptionIfOwnedByConnection`, or
 * `cleanupSubscriptionsForConnection`, change this too — the runtime-level tests in
 * `orca-runtime.test.ts` are what pin the real behavior; these doubles only pin routing.
 *
 * Why this exists: the ad-hoc `Map` stubs these tests used to carry never evicted the
 * prior generation and had no connection index, so no test could observe a
 * cross-generation teardown — which is how STA-4510 shipped. Anything exercising
 * subscribe/teardown must use this instead of a bare Map.
 */
export function createSubscriptionRegistryDouble(): SubscriptionRegistryDouble {
  const cleanups = new Map<string, Cleanup>()
  const inFlight = new Map<string, { cleanup: Cleanup; promise: Promise<void> }>()
  const byConnection = new Map<string, Set<string>>()
  const connectionByEntry = new Map<string, string>()

  const removeIndex = (id: string): void => {
    const connectionId = connectionByEntry.get(id)
    if (!connectionId) {
      return
    }
    connectionByEntry.delete(id)
    const set = byConnection.get(connectionId)
    if (!set) {
      return
    }
    set.delete(id)
    if (set.size === 0) {
      byConnection.delete(connectionId)
    }
  }

  const cleanupAndWait = (id: string): Promise<void> => {
    const cleanup = cleanups.get(id)
    if (!cleanup) {
      return Promise.resolve()
    }
    // Mirrors cleanupSubscriptionAndWait: join an in-flight attempt for this exact owner.
    const existing = inFlight.get(id)
    if (existing?.cleanup === cleanup) {
      return existing.promise
    }
    let result: void | Promise<void>
    try {
      result = cleanup()
    } catch (error) {
      result = Promise.reject(error)
    }
    const promise = Promise.resolve(result)
      .then(() => {
        // Only the generation that registered this callback may retire it.
        if (cleanups.get(id) !== cleanup) {
          return
        }
        cleanups.delete(id)
        removeIndex(id)
      })
      .finally(() => {
        if (inFlight.get(id)?.promise === promise) {
          inFlight.delete(id)
        }
      })
    inFlight.set(id, { cleanup, promise })
    return promise
  }

  // Failure retains the registration so it stays retryable, matching the runtime.
  const cleanupSubscription = (id: string): void => {
    void cleanupAndWait(id).catch(() => undefined)
  }

  const cleanupOwned = (id: string, expected: Cleanup): void => {
    if (cleanups.get(id) !== expected) {
      return
    }
    cleanupSubscription(id)
  }

  const registerSubscriptionCleanup = (
    id: string,
    cleanup: Cleanup,
    connectionId?: string
  ): void => {
    const existing = cleanups.get(id)
    if (existing) {
      removeIndex(id)
      cleanupOwned(id, existing)
    }
    cleanups.set(id, cleanup)
    if (!connectionId) {
      return
    }
    let set = byConnection.get(connectionId)
    if (!set) {
      set = new Set()
      byConnection.set(connectionId, set)
    }
    set.add(id)
    connectionByEntry.set(id, connectionId)
  }

  return {
    registerSubscriptionCleanup,
    registerOwnedSubscriptionCleanup: (id, cleanup, connectionId) => {
      registerSubscriptionCleanup(id, cleanup, connectionId)
      return {
        releaseIfCurrent: () => cleanupOwned(id, cleanup)
      }
    },
    cleanupSubscription,
    cleanupSubscriptionIfOwnedByConnection: (id, connectionId) => {
      if (!connectionId) {
        cleanupSubscription(id)
        return true
      }
      // Mirrors the production early-out: an unregistered id is already gone, not refused.
      if (!cleanups.has(id)) {
        return true
      }
      if (connectionByEntry.get(id) !== connectionId) {
        return false
      }
      cleanupSubscription(id)
      return true
    },
    cleanupSubscriptionsForConnection: (connectionId) => {
      const set = byConnection.get(connectionId)
      if (!set) {
        return
      }
      for (const id of Array.from(set)) {
        // A rebound id now belongs to another connection; skip it.
        if (connectionByEntry.get(id) !== connectionId) {
          set.delete(id)
          continue
        }
        cleanupSubscription(id)
      }
      if (set.size === 0) {
        byConnection.delete(connectionId)
      }
    },
    peekCleanup: (id) => cleanups.get(id)
  }
}
