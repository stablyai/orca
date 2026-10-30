/** Serializes advisory restart mutations without holding the lane during provider work. */
export function createStructuredAgentSessionRestartOperationQueue(): <T>(
  operation: () => Promise<T>
) => Promise<T> {
  let previous: Promise<void> = Promise.resolve()
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const result = previous.then(operation, operation)
    previous = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}
