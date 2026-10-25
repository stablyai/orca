/** The first value `pick` reads from `error`, its `cause`s or the errors a cleanup aggregated,
 *  since acquisition errors wrap what a connection or adapter threw. Bounded to six links. */
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
