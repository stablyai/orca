// One turn for every on/off change to a moved automation, so a host copy never turns on beside a released one here.

/** A host step's whole turn: a hung host must not hold every distro's undo behind it. */
export const WSL_MOVE_HOST_AUTOMATION_TURN_DEADLINE_MS = 20_000

let exclusive: Promise<unknown> = Promise.resolve()

export function runWslMoveHostAutomationsExclusive<T>(run: () => Promise<T>): Promise<T> {
  const next = exclusive.then(run, run)
  exclusive = next.catch(() => {})
  return next
}

/** A background turn that calls the host: its signal aborts the host requests at the deadline. */
export function runWslMoveHostAutomationsTurn<T>(
  run: (signal: AbortSignal) => Promise<T>,
  deadlineMs = WSL_MOVE_HOST_AUTOMATION_TURN_DEADLINE_MS
): Promise<T> {
  return runWslMoveHostAutomationsExclusive(async () => {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new Error('wsl_move_host_automation_turn_timed_out')),
      deadlineMs
    )
    try {
      return await run(controller.signal)
    } finally {
      clearTimeout(timer)
    }
  })
}

/** Rejects once `signal` aborts; a step that ignores aborts still frees the turn. */
export function untilWslMoveTurnAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // Abandoned, so its own later rejection must not go unhandled.
    work.catch(() => {})
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
