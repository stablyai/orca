// Pin happy-dom’s WeakRef-held observer callbacks while observing, matching browser lifetime; GC under parallel load otherwise silently stops mutation delivery.

type HappyDomMutationListener = {
  callback?: { deref: () => unknown }
}

type PatchableMutationObserver = {
  observe: (target: Node, options?: MutationObserverInit) => void
  disconnect: () => void
}

const MUTATION_LISTENERS_SYMBOL_DESCRIPTION = 'mutationListeners'
const RETENTION_INSTALLED = Symbol.for('orca.happyDomMutationObserverRetention')

const retainedCallbacks = new WeakMap<object, Set<unknown>>()

function readMutationListeners(target: Node): HappyDomMutationListener[] {
  const listenersSymbol = Object.getOwnPropertySymbols(target).find(
    (candidate) => candidate.description === MUTATION_LISTENERS_SYMBOL_DESCRIPTION
  )
  if (!listenersSymbol) {
    return []
  }
  const listeners = (target as unknown as Record<symbol, unknown>)[listenersSymbol]
  return Array.isArray(listeners) ? (listeners as HappyDomMutationListener[]) : []
}

/** Number of internal callbacks pinned for `observer`; drops to 0 once it disconnects. */
export function retainedMutationCallbackCount(observer: MutationObserver): number {
  return retainedCallbacks.get(observer)?.size ?? 0
}

export function installHappyDomMutationObserverRetention(): boolean {
  const observerClass = (globalThis as { MutationObserver?: typeof MutationObserver })
    .MutationObserver
  if (!observerClass) {
    return false
  }
  const prototype = observerClass.prototype as unknown as PatchableMutationObserver &
    Record<symbol, unknown>
  if (prototype[RETENTION_INSTALLED] === true) {
    return true
  }
  const observe = prototype.observe
  const disconnect = prototype.disconnect

  prototype.observe = function patchedObserve(
    this: PatchableMutationObserver,
    target: Node,
    options?: MutationObserverInit
  ): void {
    const existing = new Set(readMutationListeners(target))
    observe.call(this, target, options)
    const pinned = retainedCallbacks.get(this) ?? new Set<unknown>()
    for (const listener of readMutationListeners(target)) {
      if (existing.has(listener)) {
        continue
      }
      const callback = listener.callback?.deref()
      if (callback) {
        pinned.add(callback)
      }
    }
    if (pinned.size > 0) {
      retainedCallbacks.set(this, pinned)
    }
  }

  prototype.disconnect = function patchedDisconnect(this: PatchableMutationObserver): void {
    disconnect.call(this)
    retainedCallbacks.delete(this)
  }

  prototype[RETENTION_INSTALLED] = true
  return true
}

installHappyDomMutationObserverRetention()
