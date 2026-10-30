/** A caller's deadline detaches observation; accepted execution keeps its guarded continuation. */
export async function observePendingWorkerStart(
  execute: (onPending: (receipt: () => Promise<unknown>) => void) => Promise<unknown>,
  timeoutMs: number
): Promise<unknown> {
  const pending = Promise.withResolvers<() => Promise<unknown>>()
  let expired = false
  const deadline = Promise.withResolvers<void>()
  const timer = setTimeout(
    () => {
      expired = true
      deadline.resolve()
    },
    Math.max(0, timeoutMs)
  )
  const execution = execute(pending.resolve)
  const detached = pending.promise.then(async (receipt) => {
    if (!expired) {
      await deadline.promise
    }
    return receipt()
  })
  try {
    return await Promise.race([execution, detached])
  } finally {
    clearTimeout(timer)
  }
}
