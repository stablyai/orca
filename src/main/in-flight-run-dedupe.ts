/** Share concurrent work only; settled results are never cached. */
export function dedupeInFlightRun<T>(
  runs: Map<string, Promise<T>>,
  key: string,
  start: () => Promise<T>
): Promise<T> {
  const active = runs.get(key)
  if (active) {
    return active
  }
  const run = start()
  runs.set(key, run)
  // Clear rejected runs too, without letting a late settlement evict a newer run.
  const clear = (): void => {
    if (runs.get(key) === run) {
      runs.delete(key)
    }
  }
  void run.then(clear, clear)
  return run
}
