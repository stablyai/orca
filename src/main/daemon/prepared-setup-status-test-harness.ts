import type { SetupStatusObservation } from './prepared-setup-status'

type Observed = { attemptId: string; path: string; report: (status: number) => void }
const observed: Observed[] = []

/**
 * Stands in for `observeSetupStatus` in launch-logic tests: a report arrives synchronously, and
 * none after stop, as the real file observation guarantees. The file itself is tested separately.
 */
export function observeSetupStatus(args: {
  attemptId: string
  onStatus: (status: number) => void
}): SetupStatusObservation {
  let stopped = false
  const stop = () => {
    stopped = true
  }
  const path = `/orca-test-setup-status/${observed.length}`
  observed.push({
    attemptId: args.attemptId,
    path,
    report: (status) => {
      if (!stopped) {
        stop()
        args.onStatus(status)
      }
    }
  })
  return { path, check: async () => {}, stop }
}

/** Reports Setup's exit status for the latest observed attempt, or the one with this id. */
export function reportSetupStatus(status: number, attemptId?: string): void {
  const target = attemptId
    ? observed.findLast((entry) => entry.attemptId === attemptId)
    : observed.at(-1)
  target?.report(status)
}
