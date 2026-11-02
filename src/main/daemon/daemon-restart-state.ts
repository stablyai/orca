export type RestartDaemonResult = {
  killedCount: number
}

// Why: coalesce concurrent restartDaemon() calls so two entries can't race the 7-step sequence against a half-spawned replacement.
let restartInFlight: Promise<RestartDaemonResult> | null = null

export function isDaemonRestartInFlight(): boolean {
  return restartInFlight !== null
}

/** Settles once an in-flight restart has swapped in its provider (or failed); undefined when none. */
export function settledDaemonRestart(): Promise<void> | undefined {
  return restartInFlight?.then(
    () => undefined,
    () => undefined
  )
}

export function runCoalescedDaemonRestart(
  run: () => Promise<RestartDaemonResult>
): Promise<RestartDaemonResult> {
  if (restartInFlight) {
    return restartInFlight
  }
  restartInFlight = run().finally(() => {
    restartInFlight = null
  })
  return restartInFlight
}
