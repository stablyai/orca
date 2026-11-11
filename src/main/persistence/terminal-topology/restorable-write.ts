/** Restore the prior value only if no later write replaced next. */
export function writeRestorable<V>(read: () => V, write: (value: V) => void, next: V): () => void {
  const prior = read()
  write(next)
  return () => {
    if (read() === next) {
      write(prior)
    }
  }
}
