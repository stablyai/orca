/**
 * Serializes async operations per key. The stored queue tail never rejects, so
 * callers may await it (e.g. read-after-write barriers) without inheriting an
 * unrelated operation's failure; rejections still propagate to the enqueuer.
 */
export function runKeyedSerializedOperation<T>(
  queues: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const current = previous.then(operation)
  const queued = current.then(
    () => undefined,
    () => undefined
  )
  queues.set(key, queued)

  const clear = (): void => {
    if (queues.get(key) === queued) {
      queues.delete(key)
    }
  }
  queued.then(clear, clear)
  return current
}

export function getKeyedSerializedQueueTail(
  queues: Map<string, Promise<void>>,
  key: string
): Promise<void> {
  return queues.get(key) ?? Promise.resolve()
}
