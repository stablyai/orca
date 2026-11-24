/** Acquisition can wrap cleanup failures; search causes and aggregate errors up to six links. */
export function findInErrorChain<T>(
  error: unknown,
  pick: (error: Error) => T | undefined,
  depth = 0
): T | undefined {
  if (depth >= 6 || !(error instanceof Error)) {
    return undefined
  }
  const found = pick(error)
  if (found !== undefined) {
    return found
  }
  if (error instanceof AggregateError) {
    for (const inner of error.errors) {
      const nested = findInErrorChain(inner, pick, depth + 1)
      if (nested !== undefined) {
        return nested
      }
    }
  }
  return findInErrorChain(error.cause, pick, depth + 1)
}
