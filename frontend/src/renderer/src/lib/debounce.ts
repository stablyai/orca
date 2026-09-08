// FE-TASK-STORAGE-008: generic trailing-edge debounce with a `maxWait`
// ceiling. Checked frontend/src/renderer/src/lib/ and frontend/src/renderer/
// src/runtime/ first — workspace-port-scan-debounce.ts and
// runtime-project-refresh-scheduler.ts each implement their own bespoke,
// single-purpose scheduling loop (min-interval / per-key entries), and none
// exposes a reusable `debounce(fn, { wait, maxWait })` helper — so this is a
// new, generically reusable primitive, not a duplicate.
export type DebounceOptions = {
  /** Trailing-edge delay (ms) restarted on every call. */
  wait: number
  /** Upper bound (ms) on how long a call can be delayed once queued, even if
   *  new calls keep arriving before `wait` elapses. Optional — omit for a
   *  plain trailing debounce with no ceiling. */
  maxWait?: number
}

export type DebouncedFunction<Args extends unknown[]> = (...args: Args) => void

/** Wrap `fn` so bursts of calls collapse into one trailing invocation using
 *  the LAST call's arguments. `fn`'s return value (including a rejected
 *  promise) is intentionally not surfaced to the debounced wrapper's caller —
 *  callers that need to know the outcome should have `fn` report it itself
 *  (e.g. writing a status field), matching how this is used for fire-and-
 *  forget background sync (see flushWorkspaceSessionRemote). */
export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void | Promise<void>,
  options: DebounceOptions
): DebouncedFunction<Args> {
  let waitTimer: ReturnType<typeof setTimeout> | null = null
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null
  let pendingArgs: Args | null = null

  function clearTimers(): void {
    if (waitTimer !== null) {
      clearTimeout(waitTimer)
      waitTimer = null
    }
    if (maxWaitTimer !== null) {
      clearTimeout(maxWaitTimer)
      maxWaitTimer = null
    }
  }

  function flushNow(): void {
    const args = pendingArgs
    clearTimers()
    pendingArgs = null
    if (args !== null) {
      void fn(...args)
    }
  }

  return (...args: Args): void => {
    pendingArgs = args
    if (waitTimer !== null) {
      clearTimeout(waitTimer)
    }
    waitTimer = setTimeout(flushNow, options.wait)
    // Why only armed once per burst: resetting maxWaitTimer on every call
    // would let a steady stream of calls (e.g. session.patch on every
    // keystroke/tab-switch) postpone the flush forever — the whole point of
    // maxWait is a ceiling that does NOT reset.
    if (options.maxWait !== undefined && maxWaitTimer === null) {
      maxWaitTimer = setTimeout(flushNow, options.maxWait)
    }
  }
}
