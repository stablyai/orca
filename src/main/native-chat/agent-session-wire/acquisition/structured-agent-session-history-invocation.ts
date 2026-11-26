export type StructuredHistoryInvocationOwner = { historyCatchUp?: AbortController }

/** Existing lifecycle owners revoke the same signal while the writer is waiting. */
export async function withStructuredHistoryInvocation<T>(
  owner: StructuredHistoryInvocationOwner,
  signal: AbortSignal,
  run: (signal: AbortSignal, revoke: () => void) => Promise<T>
): Promise<T> {
  owner.historyCatchUp?.abort()
  const invocation = new AbortController()
  owner.historyCatchUp = invocation
  try {
    return await run(AbortSignal.any([signal, invocation.signal]), () => invocation.abort())
  } finally {
    invocation.abort()
    if (owner.historyCatchUp === invocation) {
      owner.historyCatchUp = undefined
    }
  }
}
