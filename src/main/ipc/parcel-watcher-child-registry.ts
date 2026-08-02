// Why: stuck retiring children still consume RSS even after their logical pool
// slot is retired, so they must count against one process-wide hard cap.
export const MAX_PHYSICAL_WATCHER_CHILDREN = 8

export class WatcherChildCapacityError extends Error {
  readonly code = 'watcher_child_capacity'

  constructor() {
    super('Physical file watcher process limit reached')
    this.name = 'WatcherChildCapacityError'
  }
}

let reservedChildren = 0
const capacityListeners = new Set<() => Promise<void>>()
let capacityNotificationsInProgress = 0
let capacityNotificationGeneration = 0

export function reserveWatcherChild(): (() => void) | null {
  if (reservedChildren >= MAX_PHYSICAL_WATCHER_CHILDREN) {
    return null
  }
  reservedChildren++
  let released = false
  return () => {
    if (!released) {
      released = true
      reservedChildren--
      notifyCapacityListeners()
    }
  }
}

export function onWatcherChildCapacityAvailable(listener: () => void | Promise<void>): () => void {
  let active = true
  const notify = async (): Promise<void> => {
    if (!active) {
      return
    }
    active = false
    capacityListeners.delete(notify)
    await listener()
  }
  capacityListeners.add(notify)
  // Why: a child may exit between a failed reservation and listener setup.
  // Recheck asynchronously so that release cannot become a lost wake-up.
  if (reservedChildren < MAX_PHYSICAL_WATCHER_CHILDREN) {
    queueMicrotask(notifyCapacityListeners)
  }
  return () => {
    active = false
    capacityListeners.delete(notify)
  }
}

function notifyCapacityListeners(): void {
  // Why: an installing callback claims one free slot until it either reserves
  // the child or finishes, so one release cannot wake every waiting root.
  while (capacityNotificationsInProgress < MAX_PHYSICAL_WATCHER_CHILDREN - reservedChildren) {
    const listener = capacityListeners.values().next().value
    if (!listener) {
      return
    }
    const generation = capacityNotificationGeneration
    capacityNotificationsInProgress++
    void listener()
      .catch((error: unknown) => {
        console.error('[parcel-watcher-child-registry] capacity listener failed:', error)
      })
      .finally(() => {
        if (generation !== capacityNotificationGeneration) {
          return
        }
        capacityNotificationsInProgress--
        notifyCapacityListeners()
      })
  }
}

export function resetWatcherChildRegistryForTest(): void {
  reservedChildren = 0
  capacityListeners.clear()
  capacityNotificationsInProgress = 0
  capacityNotificationGeneration++
}
