// Both daemon provider wrappers fan a listener out to every routed adapter and hand
// back one unsubscribe; this is that combination step, shared so neither file repeats it.
export function combineUnsubscribes(unsubscribes: (() => void)[]): () => void {
  return () => {
    for (const unsubscribe of unsubscribes) {
      unsubscribe()
    }
  }
}

/** One idempotent unsubscribe for `unsubscribes`, held in `owned` until released so dispose reaches it. */
export function trackedUnsubscribe(
  owned: (() => void)[],
  unsubscribes: (() => void)[]
): () => void {
  let active = true
  const release = (): void => {
    if (!active) {
      return
    }
    active = false
    const idx = owned.indexOf(release)
    if (idx !== -1) {
      owned.splice(idx, 1)
    }
    combineUnsubscribes(unsubscribes)()
  }
  owned.push(release)
  return release
}

/** Adds `callback` to `listeners` and returns the matching removal. */
export function addListener<T>(listeners: T[], callback: T): () => void {
  listeners.push(callback)
  return () => {
    const idx = listeners.indexOf(callback)
    if (idx !== -1) {
      listeners.splice(idx, 1)
    }
  }
}
