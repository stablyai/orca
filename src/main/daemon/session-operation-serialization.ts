// Callers own distinct queues for nested router custody and adapter history operations.
export async function serializeSessionOperation<T>(
  queues: Map<string, Promise<void>>,
  sessionId: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = queues.get(sessionId) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(
    () => current,
    () => current
  )
  queues.set(sessionId, tail)
  await previous.catch(() => {})
  try {
    return await operation()
  } finally {
    release()
    if (queues.get(sessionId) === tail) {
      queues.delete(sessionId)
    }
  }
}
