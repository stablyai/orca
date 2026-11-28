import type { HangObservation } from './hang-observation-schema'

function endedUnrecovered(item: HangObservation): boolean {
  return (
    !item.selfRecovered &&
    !item.resolution &&
    !item.watchdogGap &&
    !item.powerEvents.some((receipt) => receipt.event === 'suspend')
  )
}

/** The previous run ended (force quit, kill, crash) during this stall: heartbeats never resumed and no sleep or gap explains it. */
export function findUnrecoveredStall(
  observations: readonly HangObservation[]
): HangObservation | null {
  // Last stall per run: a later launch's recovered or slept stall must not hide an earlier run's unrecovered one.
  const lastPerRun = new Map<number, HangObservation>()
  for (const item of observations) {
    if (item.kind === 'heartbeat-stall') {
      lastPerRun.set(item.parentPid, item)
    }
  }
  return [...lastPerRun.values()].findLast(endedUnrecovered) ?? null
}
