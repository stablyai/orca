// Forked with ELECTRON_RUN_AS_NODE from the main process. Watches heartbeats from the main
// thread; if they stop (e.g. the macOS 26 AppKit scene-update deadlock) it records a marker so
// the next launch can report the stall, and rewrites it if the heartbeats come back.
//
// Why no kill: a deadlocked main thread has already lost whatever sat in the persistence debounce
// window, so killing it recovers nothing the user could not recover by force-quitting. A false
// positive, though, would SIGKILL a live main thread that was merely blocked — most plausibly on
// I/O, i.e. exactly when writes are in flight. All of the downside sits in the misfire, so this
// measures first: `selfRecovered` counts the stalls a killer would have gotten wrong.
//
// Must never import electron.
import { createHangWatchdogChildLoop } from './hang-watchdog-child-loop'
import { writeHangDetectionMarker } from './hang-detection-marker'

const DEFAULT_TIMEOUT_MS = 45_000
const DEFAULT_CHECK_INTERVAL_MS = 5_000

export function recordHangObservation(options: {
  parentPid: number
  markerPath: string
  unresponsiveMs: number
  selfRecovered: boolean
}): void {
  if (!options.markerPath) {
    return
  }
  try {
    writeHangDetectionMarker(options.markerPath, {
      detectedAt: Date.now(),
      parentPid: options.parentPid,
      unresponsiveMs: options.unresponsiveMs,
      selfRecovered: options.selfRecovered
    })
  } catch {
    // Why: telemetry is best-effort; a marker that cannot be written must not take down the watchdog.
  }
}

function runWatchdog(parentPid: number): void {
  const markerPath = process.env.ORCA_HANG_WATCHDOG_MARKER_PATH ?? ''
  const timeoutMs = Number(process.env.ORCA_HANG_WATCHDOG_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS
  const checkIntervalMs =
    Number(process.env.ORCA_HANG_WATCHDOG_CHECK_INTERVAL_MS) || DEFAULT_CHECK_INTERVAL_MS

  const loop = createHangWatchdogChildLoop({
    timeoutMs,
    checkIntervalMs,
    now: () => Date.now(),
    onHangDetected: (unresponsiveMs) =>
      recordHangObservation({ parentPid, markerPath, unresponsiveMs, selfRecovered: false }),
    // Why: rewriting the marker keeps one observation per stall rather than two rows to reconcile.
    onHangResolved: (unresponsiveMs) =>
      recordHangObservation({ parentPid, markerPath, unresponsiveMs, selfRecovered: true })
  })

  process.on('message', (message) => {
    const type = (message as { type?: string } | null)?.type
    if (type === 'heartbeat') {
      loop.recordHeartbeat()
    } else if (type === 'shutdown') {
      process.exit(0)
    }
  })
  // Why: a normal parent exit closes the IPC channel; the watchdog must not outlive it and misfire.
  process.on('disconnect', () => process.exit(0))
  setInterval(() => loop.tick(), checkIntervalMs)
}

const configuredParentPid = Number(process.env.ORCA_HANG_WATCHDOG_PARENT_PID)
if (Number.isInteger(configuredParentPid) && configuredParentPid > 0) {
  runWatchdog(configuredParentPid)
}
