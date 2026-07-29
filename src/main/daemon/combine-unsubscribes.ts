// Both daemon provider wrappers fan a listener out to every routed adapter and hand
// back one unsubscribe; this is that combination step, shared so neither file repeats it.
export function combineUnsubscribes(unsubscribes: (() => void)[]): () => void {
  return () => {
    for (const unsubscribe of unsubscribes) {
      unsubscribe()
    }
  }
}
