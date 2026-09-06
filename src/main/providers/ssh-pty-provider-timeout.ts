/** Convert an absolute deadline into the relay's remaining timeout budget. */
export function relayTimeoutOptions(
  deadlineMs: number | undefined,
  signal?: AbortSignal
): { timeoutMs?: number; signal?: AbortSignal } | undefined {
  if (deadlineMs === undefined && signal === undefined) {
    return undefined
  }
  return {
    ...(deadlineMs === undefined ? {} : { timeoutMs: Math.max(1, deadlineMs - Date.now()) }),
    ...(signal ? { signal } : {})
  }
}
