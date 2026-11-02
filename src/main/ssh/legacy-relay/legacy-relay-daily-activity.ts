/**
 * One `active` telemetry row per target per UTC day while it bridges relay terminals, so the
 * relay's retirement can see who still uses it. COMPAT(legacy-relay-bridge): revisit 2027-01-15.
 */
type ActivityReport = (targetId: string, phase: 'active', terminals: number) => void

/** Why a timer: a terminal left attached across midnight changes no pane and attaches nothing. */
const CHECK_INTERVAL_MS = 60 * 60 * 1000

const reportedDayByTarget = new Map<string, string>()
let timer: ReturnType<typeof setInterval> | null = null

export function reportDailyRelayActivity(
  targetId: string,
  liveTerminals: number,
  report: ActivityReport
): void {
  const day = new Date().toISOString().slice(0, 10)
  if (liveTerminals <= 0 || reportedDayByTarget.get(targetId) === day) {
    return
  }
  reportedDayByTarget.set(targetId, day)
  report(targetId, 'active', liveTerminals)
}

/** Replaces the previous watch; `null` stops it, as uninstalling the bridge does. */
export function watchDailyRelayActivity(
  host: { report: ActivityReport } | null,
  liveByTarget: () => Iterable<readonly [string, number]>
): void {
  reportedDayByTarget.clear()
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (!host) {
    return
  }
  timer = setInterval(() => {
    for (const [targetId, live] of liveByTarget()) {
      reportDailyRelayActivity(targetId, live, host.report)
    }
  }, CHECK_INTERVAL_MS)
  timer.unref?.()
}
