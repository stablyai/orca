/** Abort when the caller aborts or after `timeoutMs`, whichever comes first. */
export function abortSignalWithTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}
