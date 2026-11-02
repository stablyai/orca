/** A caller's deadline detaches observation; accepted execution keeps its guarded continuation. */
export async function observePendingWorkerStart(
  execute: (
    onPending: (receipt: () => Promise<unknown>) => void,
    /** True once accepted work may outlive its caller, so the continuation owns what the caller would do. */
    pendingOffered: () => boolean
  ) => Promise<unknown>,
  timeoutMs: number
): Promise<unknown> {
  const pending = Promise.withResolvers<() => Promise<unknown>>()
  let offered = false
  let expired = false
  const deadline = Promise.withResolvers<void>()
  const timer = setTimeout(
    () => {
      expired = true
      deadline.resolve()
    },
    Math.max(0, timeoutMs)
  )
  const execution = execute(
    (receipt) => {
      offered = true
      pending.resolve(receipt)
    },
    () => offered
  )
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
