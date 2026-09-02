/**
 * Shares one in-flight promise per key so concurrent callers that want the same
 * result run the work once. Purely a concurrency collapse, never a cache: the
 * entry is dropped the moment the run settles, so the next caller starts fresh
 * and re-reads whatever state the run depends on.
 *
 * Callers own the map, which keeps each lane's exact result type (including
 * nullable ones) without a cast at every read.
 */
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
  // Why: clear on rejection too, or one failure would wedge every later caller
  // onto the same rejected promise. The identity check keeps a late settle from
  // evicting a newer entry for the same key.
  const clear = (): void => {
    if (runs.get(key) === run) {
      runs.delete(key)
    }
  }
  void run.then(clear, clear)
  return run
}
