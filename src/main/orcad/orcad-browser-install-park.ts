import {
  ORCAD_BROWSER_PARK_LABEL,
  SERVE_SUPERVISOR_HEARTBEAT_MS
} from '../../shared/serve-bundle-coordination'
import { openServeBundlePark, type ServeBundlePark } from '../../shared/serve-bundle-park'

const PARK_POLL_MS = 1_000
const RESTART_RETRY_MIN_MS = 5_000
const RESTART_RETRY_MAX_MS = 5 * 60_000

type OrcadBrowserHelper = {
  pid: () => number | null
  start: (signal: AbortSignal) => Promise<void>
  stop: () => Promise<void>
}

type OrcadBrowserInstallPark = { close: () => Promise<void> }

/** Stop installed-app helpers for macOS bundle replacement, then restart from the new bundle.
 * Stale heartbeats refuse installation rather than stopping a wedged owner’s helper. */
export function watchOrcadBrowserInstallPark(
  helper: OrcadBrowserHelper,
  deps: {
    park: ServeBundlePark
    setRepeating?: (callback: () => void, ms: number) => () => void
    now?: () => number
    log?: (message: string, error: unknown) => void
  }
): OrcadBrowserInstallPark {
  const { park } = deps
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((message, error) => console.warn(message, error))
  const acked = new Set<string>()
  // Retain parked state until restart succeeds so failures retry.
  let parked = false
  let restartAt = 0
  let restartDelayMs = RESTART_RETRY_MIN_MS
  let closed = false
  let restarting: AbortController | null = null
  let inFlight: Promise<void> | null = null
  let lastBeat: { pid: number | null | undefined; at: number } = { pid: undefined, at: 0 }

  const beat = (pid: number | null): void => {
    if (closed) {
      return
    }
    if (pid !== lastBeat.pid || now() - lastBeat.at >= SERVE_SUPERVISOR_HEARTBEAT_MS) {
      park.heartbeat(pid)
      lastBeat = { pid, at: now() }
    }
  }

  const run = (operation: () => Promise<void>): void => {
    inFlight = operation()
      .catch((error: unknown) => log('[orcad] Browser install park step failed:', error))
      .finally(() => {
        inFlight = null
      })
  }

  const restart = async (): Promise<void> => {
    const controller = new AbortController()
    restarting = controller
    try {
      await helper.start(controller.signal)
      parked = false
      restartDelayMs = RESTART_RETRY_MIN_MS
    } catch (error) {
      if (controller.signal.aborted) {
        return
      }
      restartAt = now() + restartDelayMs
      restartDelayMs = Math.min(restartDelayMs * 2, RESTART_RETRY_MAX_MS)
      throw error
    } finally {
      restarting = null
    }
  }

  const tick = (): void => {
    if (closed) {
      return
    }
    if (inFlight) {
      // Abort slow starts so the next tick can stop/ack within the installer’s deadline.
      if (restarting && park.pendingPark()) {
        restarting.abort()
      }
      // Slow stop/start must not make registration appear abandoned.
      beat(helper.pid())
      return
    }
    const pending = park.pendingPark()
    const attemptId = pending && !acked.has(pending.attemptId) ? pending.attemptId : null
    // Unacknowledged committed installs still require the helper to stop.
    if (attemptId !== null || (!parked && park.holds())) {
      parked = true
      // New installs bypass old restart-failure backoff.
      restartAt = 0
      restartDelayMs = RESTART_RETRY_MIN_MS
      run(async () => {
        await helper.stop()
        beat(null)
        if (attemptId !== null && !closed) {
          acked.add(attemptId)
          park.ack(attemptId)
        }
      })
      return
    }
    if (parked && !park.holds() && now() >= restartAt) {
      run(restart)
      return
    }
    beat(helper.pid())
  }

  const cancel = (deps.setRepeating ?? setRepeatingTimer)(tick, PARK_POLL_MS)
  beat(helper.pid())
  return {
    close: async () => {
      closed = true
      cancel()
      restarting?.abort()
      await inFlight
      park.unregister()
    }
  }
}

function setRepeatingTimer(callback: () => void, ms: number): () => void {
  const timer = setInterval(callback, ms)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** Register only helpers launched from macOS app bundles. */
export function openOrcadBrowserInstallPark(
  executable: string,
  helper: OrcadBrowserHelper
): OrcadBrowserInstallPark | null {
  const park = openServeBundlePark({ executable, label: ORCAD_BROWSER_PARK_LABEL })
  return park ? watchOrcadBrowserInstallPark(helper, { park }) : null
}
