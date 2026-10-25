import {
  ORCAD_BROWSER_PARK_LABEL,
  SERVE_SUPERVISOR_HEARTBEAT_MS
} from '../../shared/serve-bundle-coordination'
import { openServeBundlePark, type ServeBundlePark } from '../../shared/serve-bundle-park'

const PARK_POLL_MS = 1_000
const RESTART_RETRY_MIN_MS = 5_000
const RESTART_RETRY_MAX_MS = 5 * 60_000

type OrcadBrowserHelper = {
  /** The running helper's pid, or null when none runs. */
  pid: () => number | null
  start: (signal: AbortSignal) => Promise<void>
  stop: () => Promise<void>
}

type OrcadBrowserInstallPark = { close: () => Promise<void> }

/**
 * The browser helper runs from the installed Orca.app, so macOS cannot replace that bundle while it
 * lives. orcad registers it in the desktop installer's park: stop it for the install, start it
 * again from the new bundle once the hold ends. An orcad that stops heartbeating goes stale and the
 * installer refuses as before, so a wedged orcad never has its helper stopped for it.
 */
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
  /** True from the stop until a restart succeeds, so a failed restart is retried, not dropped. */
  let parked = false
  let restartAt = 0
  let restartDelayMs = RESTART_RETRY_MIN_MS
  let closed = false
  /** The running restart's abort: close() and a new park both cancel it. */
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
      // Same executable path: after a completed install this is the new bundle's helper.
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
      // Why: a start can outlast the installer's ack wait; give way so the next tick stops and acks.
      if (restarting && park.pendingPark()) {
        restarting.abort()
      }
      // Why beat mid-step: a slow stop must not let the registration go stale and look abandoned.
      beat(helper.pid())
      return
    }
    const pending = park.pendingPark()
    const attemptId = pending && !acked.has(pending.attemptId) ? pending.attemptId : null
    // Why holds() too: an install committed by an attempt this orcad never acked still needs it stopped.
    if (attemptId !== null || (!parked && park.holds())) {
      parked = true
      // A new install restarts from its own bundle; an older failure's backoff does not apply.
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
  // Why unref: the park watch must never keep a stopping orcad alive.
  timer.unref?.()
  return () => clearInterval(timer)
}

/** Opens the park only for a helper launched from a macOS .app bundle; null everywhere else. */
export function openOrcadBrowserInstallPark(
  executable: string,
  helper: OrcadBrowserHelper
): OrcadBrowserInstallPark | null {
  const park = openServeBundlePark({ executable, label: ORCAD_BROWSER_PARK_LABEL })
  return park ? watchOrcadBrowserInstallPark(helper, { park }) : null
}
