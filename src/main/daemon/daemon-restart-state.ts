export type RestartDaemonResult = {
  killedCount: number
}

// Why: coalesce concurrent restartDaemon() calls so two entries can't race the 7-step sequence against a half-spawned replacement.
let restartInFlight: Promise<RestartDaemonResult> | null = null

export function isDaemonRestartInFlight(): boolean {
  return restartInFlight !== null
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
