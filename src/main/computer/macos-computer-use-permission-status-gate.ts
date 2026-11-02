import type { ComputerUsePermissionStatusResult } from '../../shared/computer-use-permissions-types'

// Each macOS probe launches a helper that settles TCC for ~2s; 5s between real spawns allows 12 per 60s window.
// performance.now is monotonic, so a wall-clock step can't stretch or skip the floor.
const PERMISSION_STATUS_LAUNCH_FLOOR_MS = 5_000
// A probe older than this may predate a grant, so a denial from it sends the reader to the next probe.
const PERMISSION_STATUS_FRESH_JOIN_MS = 300

type StatusResult = ComputerUsePermissionStatusResult

export type PermissionStatusGate = {
  read: () => Promise<StatusResult>
  // Setup's cheapest answer: in-flight, recent grant or last denial, before launching anything new.
  peek: () => Promise<StatusResult>
  invalidate: () => void
}

// probe calls markSpawned when its helper actually starts; the floor counts from the later of claim and spawn.
export function createPermissionStatusGate(
  probe: (markSpawned: () => void) => Promise<StatusResult>
): PermissionStatusGate {
  let inFlight: { promise: Promise<StatusResult>; joinable: boolean } | null = null
  let lastLaunchAt = Number.NEGATIVE_INFINITY
  // Only grants are cached; a denial or error is never served, so a fresh grant shows within one floor.
  let granted: StatusResult | null = null
  // Reuse ends one floor after the probe that produced the answer, not after whichever probe ran last.
  let cachedUntil = Number.NEGATIVE_INFINITY
  // Setup may reuse a denial until the floor expires, so it never acts on one older than a floor.
  let lastDenied: StatusResult | null = null
  let waiters: {
    promise: Promise<StatusResult>
    resolve: (next: Promise<StatusResult>) => void
  } | null = null
  let trailingTimer: ReturnType<typeof setTimeout> | null = null

  const floorExpiresAt = (): number => lastLaunchAt + PERMISSION_STATUS_LAUNCH_FLOOR_MS

  const armTrailing = (): void => {
    if (!waiters || inFlight || trailingTimer) {
      return
    }
    trailingTimer = setTimeout(
      () => {
        trailingTimer = null
        if (waiters && !inFlight && performance.now() >= floorExpiresAt()) {
          void launch().catch(() => {})
        } else {
          armTrailing()
        }
      },
      Math.max(0, Math.ceil(floorExpiresAt() - performance.now()))
    )
    trailingTimer.unref?.()
  }

  const launch = (): Promise<StatusResult> => {
    lastLaunchAt = performance.now()
    if (trailingTimer) {
      clearTimeout(trailingTimer)
      trailingTimer = null
    }
    const entry = {
      promise: probe(() => {
        lastLaunchAt = Math.max(lastLaunchAt, performance.now())
      }),
      joinable: true
    }
    inFlight = entry
    entry.promise
      .then(
        (result) => {
          if (entry.joinable) {
            granted = isCacheable(result) ? result : null
            lastDenied = granted ? null : result
            cachedUntil = floorExpiresAt()
          }
        },
        () => {
          granted = null
          lastDenied = null
        }
      )
      .finally(() => {
        if (inFlight === entry) {
          inFlight = null
        }
        armTrailing()
      })
    // Readers waiting out the floor take whichever probe starts next, whatever triggered it.
    const pending = waiters
    waiters = null
    pending?.resolve(entry.promise)
    return entry.promise
  }

  const waitForNextProbe = (): Promise<StatusResult> => {
    if (!waiters) {
      let resolve: (next: Promise<StatusResult>) => void = () => {}
      const promise = new Promise<StatusResult>((settle) => {
        resolve = settle
      })
      waiters = { promise, resolve }
    }
    armTrailing()
    return waiters.promise
  }

  const read = (): Promise<StatusResult> => {
    if (granted && performance.now() < cachedUntil) {
      return Promise.resolve(granted)
    }
    if (inFlight?.joinable) {
      const joined = inFlight.promise
      if (performance.now() - lastLaunchAt <= PERMISSION_STATUS_FRESH_JOIN_MS) {
        return joined
      }
      return joined.then((result) => (isCacheable(result) ? result : waitForNextProbe()))
    }
    if (!inFlight && performance.now() >= floorExpiresAt()) {
      return launch()
    }
    return waitForNextProbe()
  }

  return {
    read,
    peek: () => {
      if (inFlight?.joinable) {
        return inFlight.promise
      }
      if (granted && performance.now() < cachedUntil) {
        return Promise.resolve(granted)
      }
      return lastDenied && performance.now() < cachedUntil ? Promise.resolve(lastDenied) : read()
    },
    invalidate: () => {
      granted = null
      lastDenied = null
      if (inFlight) {
        inFlight.joinable = false
      }
    }
  }
}

// A missing helper answers without launching anything, so it is as safe to reuse as a grant.
function isCacheable(result: StatusResult): boolean {
  return (
    result.helperUnavailableReason !== null ||
    result.permissions.every((permission) => permission.status !== 'not-granted')
  )
}

async function probeStatus(markSpawned: () => void = () => {}): Promise<StatusResult> {
  const { getComputerUsePermissionStatus } = await import('./macos-computer-use-permissions')
  return getComputerUsePermissionStatus(markSpawned)
}

const macosGate = createPermissionStatusGate(probeStatus)

// Off macOS the probe answers 'unsupported' instantly without a helper, so it skips the gate.
export const computerUsePermissionStatusGate: PermissionStatusGate = {
  read: () => (process.platform === 'darwin' ? macosGate.read() : probeStatus()),
  peek: () => (process.platform === 'darwin' ? macosGate.peek() : probeStatus()),
  invalidate: () => macosGate.invalidate()
}
