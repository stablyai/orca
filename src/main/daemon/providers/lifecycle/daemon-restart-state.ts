export type RestartDaemonResult = {
  killedCount: number
}

let restartInFlight: Promise<RestartDaemonResult> | null = null

export function isDaemonRestartInFlight(): boolean {
  return restartInFlight !== null
}

/** Wait for the current restart, suppressing its failure; undefined when idle. */
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
