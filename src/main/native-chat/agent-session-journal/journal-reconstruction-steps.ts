/** Private reconstruction may pause; a published model is adopted only after it is complete. */
export function finishJournalSteps<T>(steps: Generator<void, T>): T {
  for (;;) {
    const next = steps.next()
    if (next.done) {
      return next.value
    }
  }
}

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

/** Stable merge runs preserve insertion order for equal canonical ordinals. */
export function* sortJournalSteps<T>(
  values: Iterable<T>,
  compare: (a: T, b: T) => number
): Generator<void, T[]> {
  let source: T[] = []
  for (const value of values) {
    source.push(value)
    yield
  }
  let target: T[] = []
  for (let width = 1; width < source.length; width *= 2) {
    for (let start = 0; start < source.length; start += 2 * width) {
      let left = start
      const middle = Math.min(start + width, source.length)
      let right = middle
      const end = Math.min(start + 2 * width, source.length)
      while (left < middle || right < end) {
        target.push(
          right >= end || (left < middle && !(compare(source[left], source[right]) > 0))
            ? source[left++]
            : source[right++]
        )
        yield
      }
    }
    ;[source, target] = [target, source]
    target.length = 0
  }
  return source
}
