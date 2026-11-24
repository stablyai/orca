export function orderPRWatchOutcome<T>(
  outcomes: Map<string, Promise<unknown>>,
  prKey: string,
  run: () => Promise<T>
): Promise<T> {
  const result = (outcomes.get(prKey) ?? Promise.resolve()).then(run)
  const settled = result
    .catch(() => {})
    .finally(() => {
      if (outcomes.get(prKey) === settled) {
        outcomes.delete(prKey)
      }
    })
  outcomes.set(prKey, settled)
  return result
}
