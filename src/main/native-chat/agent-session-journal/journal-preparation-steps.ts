export async function finishJournalStepsAsync<T>(
  steps: Generator<void, T>,
  scope: (next: () => IteratorResult<void, T>) => IteratorResult<void, T> = (next) => next()
): Promise<T> {
  let work = 0
  for (;;) {
    const next = scope(() => steps.next())
    if (next.done) {
      return next.value
    }
    if (++work === 256) {
      work = 0
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
}
