// Why: both provider login services invoke caller-supplied callbacks
// (onOutput/onChildReady) synchronously from inside a child-process stream
// handler; a throwing callback must not escape and crash the host process,
// so every call site swallows and logs instead of propagating.
export function invokeLoginCallbackSafely<TArgs extends unknown[]>(
  logContext: string,
  callback: ((...args: TArgs) => void) | undefined,
  ...args: TArgs
): void {
  if (!callback) {
    return
  }
  try {
    callback(...args)
  } catch (error) {
    console.warn(`[${logContext}] callback threw:`, error)
  }
}
