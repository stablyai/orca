import type { HangObservation, HangPowerReceipt } from './hang-observation-schema'

export type SleepPeriod = { suspend: HangPowerReceipt; resumeAt: number | null }

/** Whether a watchdog gap began with a received suspend, and the power receipts to keep on the observation. */
export function sleepAssociation(input: {
  kind: HangObservation['kind']
  startedAt: number
  now: number
  sleepPeriod: SleepPeriod | null
  recentPower: readonly HangPowerReceipt[]
  checkIntervalMs: number
}): { initialSleepAssociated: boolean; powerEvents: HangPowerReceipt[] } {
  const { kind, startedAt, now, sleepPeriod, recentPower, checkIntervalMs } = input
  const suspend = sleepPeriod?.suspend
  const initialSleepAssociated =
    kind === 'watchdog-gap' &&
    !!suspend &&
    suspend.observedAt <= startedAt + checkIntervalMs &&
    suspend.receivedAt <= startedAt + checkIntervalMs &&
    suspend.receivedAt < now - checkIntervalMs &&
    suspend.receivedAt >= suspend.observedAt &&
    suspend.receivedAt - suspend.observedAt <= checkIntervalMs &&
    (sleepPeriod?.resumeAt ?? Infinity) > startedAt
  let powerEvents = recentPower
    .filter((item) => item.observedAt >= startedAt && item.receivedAt <= now)
    .slice(-4)
  if (initialSleepAssociated && suspend) {
    powerEvents = [suspend, ...powerEvents.filter((item) => item !== suspend).slice(-3)]
  }
  return { initialSleepAssociated, powerEvents }
}
