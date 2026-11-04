export function combineUnsubscribes(unsubscribes: (() => void)[]): () => void {
  return () => {
    for (const unsubscribe of unsubscribes) {
      unsubscribe()
    }
  }
}
