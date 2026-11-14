import {
  indexPendingVmCheckouts,
  EMPTY_PENDING_VM_CHECKOUT_INDEX,
  type PendingVmCheckout,
  type PendingVmCheckoutIndex
} from '../../shared/pending-vm-checkouts'

/**
 * VM checkouts whose creates are still in progress, per publishing window. Every window, the
 * paired phone's host lists and the jump palette read the union, so none lists a checkout the
 * create has not adopted yet.
 */
export class PendingVmCheckoutRegistry {
  private readonly byOwner = new Map<number, PendingVmCheckout[]>()
  private index: PendingVmCheckoutIndex = EMPTY_PENDING_VM_CHECKOUT_INDEX
  private readonly listeners = new Set<() => void>()

  /** Replaces one window's set; an empty list drops the window. An unchanged set is a no-op. */
  publish(ownerId: number, checkouts: PendingVmCheckout[]): void {
    const before = this.byOwner.get(ownerId) ?? []
    if (sameCheckouts(before, checkouts)) {
      return
    }
    if (checkouts.length === 0) {
      this.byOwner.delete(ownerId)
    } else {
      this.byOwner.set(ownerId, checkouts)
    }
    this.index = indexPendingVmCheckouts([...this.byOwner.values()].flat())
    this.listeners.forEach((listener) => listener())
  }

  list(): PendingVmCheckout[] {
    return [...this.byOwner.values()].flat()
  }

  /** What one window needs from the others; it already holds its own. */
  listExcept(ownerId: number): PendingVmCheckout[] {
    return [...this.byOwner].flatMap(([owner, checkouts]) => (owner === ownerId ? [] : checkouts))
  }

  current(): PendingVmCheckoutIndex {
    return this.index
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

/**
 * Calls `notify` with each repo whose pending checkouts changed, so paired phones re-read their
 * host workspace lists instead of keeping rows from a fetch made before the change reached main.
 */
export function publishPendingVmCheckoutRepoChanges(
  registry: PendingVmCheckoutRegistry,
  notify: (repoId: string) => void
): () => void {
  const keyOf = (checkout: PendingVmCheckout): string => `${checkout.repoId}\0${checkout.path}`
  let before = new Map(registry.list().map((checkout) => [keyOf(checkout), checkout.repoId]))
  return registry.onChanged(() => {
    const after = new Map(registry.list().map((checkout) => [keyOf(checkout), checkout.repoId]))
    const changed = new Set<string>()
    for (const [key, repoId] of before) {
      if (!after.has(key)) {
        changed.add(repoId)
      }
    }
    for (const [key, repoId] of after) {
      if (!before.has(key)) {
        changed.add(repoId)
      }
    }
    before = after
    changed.forEach(notify)
  })
}

function sameCheckouts(left: PendingVmCheckout[], right: PendingVmCheckout[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (checkout, i) => checkout.repoId === right[i].repoId && checkout.path === right[i].path
    )
  )
}

export const pendingVmCheckouts = new PendingVmCheckoutRegistry()
