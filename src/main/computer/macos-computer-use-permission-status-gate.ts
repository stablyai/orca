import type { ComputerUsePermissionStatusResult } from '../../shared/computer-use-permissions-types'

// Each macOS probe launches a helper that polls TCC for ~3.5s; denied answers only change on user action.
const PERMISSION_STATUS_RESULT_REUSE_MS = 2_000
const PERMISSION_STATUS_DENIED_MIN_BACKOFF_MS = 10_000
const PERMISSION_STATUS_DENIED_MAX_BACKOFF_MS = 120_000

type ProbeOutcome =
  | { ok: true; result: ComputerUsePermissionStatusResult }
  | { ok: false; error: unknown }

type InFlightProbe = {
  epoch: number
  promise: Promise<ComputerUsePermissionStatusResult>
  followUp: Promise<ComputerUsePermissionStatusResult> | null
}

export type PermissionStatusReadOptions = {
  // Local passive badges opt into the denied backoff; foreground reads never get a cached denial.
  background?: boolean
}

export type PermissionStatusProbeGate = {
  read: (options?: PermissionStatusReadOptions) => Promise<ComputerUsePermissionStatusResult>
  noteAppDeparture: () => void
  noteAppReturn: () => void
  setAppActiveProbe: (isAppActive: () => boolean) => void
  invalidate: () => void
}

export type AppActivitySource = {
  onDeparture: (listener: () => void) => void
  onReturn: (listener: () => void) => void
  isAppActive: () => boolean
}

export function createPermissionStatusProbeGate(options: {
  probe: () => Promise<ComputerUsePermissionStatusResult>
  now?: () => number
}): PermissionStatusProbeGate {
  const now = options.now ?? Date.now
  // A new epoch means the answer may have changed; results from older epochs are never served.
  let epoch = 0
  let departed = false
  let isAppActive = (): boolean => false
  let inFlight: InFlightProbe | null = null
  let cached: { epoch: number; outcome: ProbeOutcome; finishedAt: number } | null = null
  let reuseUntil = 0
  let deniedStreak = 0

  const noteAppReturn = (): void => {
    if (departed) {
      departed = false
      epoch += 1
    }
  }

  const recordOutcome = (probeEpoch: number, outcome: ProbeOutcome): void => {
    if (probeEpoch !== epoch) {
      return
    }
    const finishedAt = now()
    cached = { epoch: probeEpoch, outcome, finishedAt }
    if (!outcome.ok || !isMissingPermission(outcome.result)) {
      if (outcome.ok) {
        deniedStreak = 0
      }
      reuseUntil = finishedAt + PERMISSION_STATUS_RESULT_REUSE_MS
      return
    }
    deniedStreak += 1
    const backoff = PERMISSION_STATUS_DENIED_MIN_BACKOFF_MS * 2 ** (deniedStreak - 1)
    reuseUntil = finishedAt + Math.min(backoff, PERMISSION_STATUS_DENIED_MAX_BACKOFF_MS)
  }

  const startProbe = (): Promise<ComputerUsePermissionStatusResult> => {
    const probeEpoch = epoch
    const entry: InFlightProbe = {
      epoch: probeEpoch,
      promise: options.probe().then(
        (result) => {
          recordOutcome(probeEpoch, { ok: true, result })
          return result
        },
        (error: unknown) => {
          recordOutcome(probeEpoch, { ok: false, error })
          throw error
        }
      ),
      followUp: null
    }
    inFlight = entry
    void entry.promise
      .finally(() => {
        if (inFlight === entry) {
          inFlight = null
        }
      })
      .catch(() => {})
    return entry.promise
  }

  const reuseLimit = (
    entry: { outcome: ProbeOutcome; finishedAt: number },
    readOptions: PermissionStatusReadOptions
  ): number => {
    if (readOptions.background) {
      return reuseUntil
    }
    // Foreground readers may have just granted; only passive badges accept a finished denial.
    if (entry.outcome.ok && isMissingPermission(entry.outcome.result)) {
      return 0
    }
    return entry.finishedAt + PERMISSION_STATUS_RESULT_REUSE_MS
  }

  const read = (
    readOptions: PermissionStatusReadOptions = {}
  ): Promise<ComputerUsePermissionStatusResult> => {
    // The renderer's focus read can reach main before did-become-active does.
    if (departed && isAppActive()) {
      noteAppReturn()
    }
    const current = inFlight
    if (current) {
      if (current.epoch === epoch) {
        return current.promise
      }
      // Never run two helpers at once; re-probe once the stale one settles.
      current.followUp ??= current.promise.then(noop, noop).then(() => read(readOptions))
      return current.followUp
    }
    if (cached && cached.epoch === epoch) {
      if (now() < reuseLimit(cached, readOptions)) {
        const { outcome } = cached
        return outcome.ok ? Promise.resolve(outcome.result) : Promise.reject(outcome.error)
      }
    }
    return startProbe()
  }

  return {
    read,
    noteAppDeparture: () => {
      departed = true
    },
    noteAppReturn,
    setAppActiveProbe: (probe) => {
      isAppActive = probe
    },
    invalidate: () => {
      epoch += 1
      deniedStreak = 0
    }
  }
}

// App-level activation only: moving between Orca's own windows can't change a TCC answer.
export function bindPermissionStatusGateToAppActivity(
  gate: PermissionStatusProbeGate,
  activity: AppActivitySource
): void {
  gate.setAppActiveProbe(activity.isAppActive)
  // Listeners attach after startup; a grant made while Orca was inactive must count on first return.
  if (!activity.isAppActive()) {
    gate.noteAppDeparture()
  }
  activity.onDeparture(() => gate.noteAppDeparture())
  activity.onReturn(() => gate.noteAppReturn())
}

function noop(): void {}

function isMissingPermission(result: ComputerUsePermissionStatusResult): boolean {
  return (
    result.helperUnavailableReason === null &&
    result.permissions.some((permission) => permission.status === 'not-granted')
  )
}

export const computerUsePermissionStatusGate = createPermissionStatusProbeGate({
  probe: async () => {
    const { getComputerUsePermissionStatus } = await import('./macos-computer-use-permissions')
    return getComputerUsePermissionStatus()
  }
})
