import { app, type BrowserWindow, type WebContents } from 'electron'
import type { CrashReportBreadcrumbData, CrashReportDetailValue } from '../../shared/crash-reporting'
import { recordDurableCrashBreadcrumb } from './durable-crash-breadcrumb'
import { collectProcessGoneMetricDetails } from './process-gone-diagnostics'

// Why: a renderer main-thread freeze (one long synchronous task) stops the
// renderer's own `renderer_memory` heartbeat, so a runaway allocation up to the
// V8 limit lands as a silent multi-minute gap before `render-process-gone`.
// The main process stays live during that freeze, so it can still read the
// frozen renderer's working set via getAppMetrics and see Electron's
// `unresponsive` signal — the only vantage point that observes the climb.
//
// Re-arm across an in-place reload: when the frozen renderer OOM-dies, the focus
// lifecycle reloads the SAME BrowserWindow in place, reusing this same
// webContents object with a fresh renderer on a new OS process. Death detection
// is therefore keyed on that process identity, not on catching the
// ~250ms-transient crashed state: `onUnresponsive` treats a freeze whose onset
// identity differs from the live one as a fresh freeze (so the reloaded
// renderer's next freeze is never dropped as a stale duplicate), and the sampler
// resets the instant it sees the identity change. A polled isDestroyed/isCrashed
// check is kept only as a backstop. We do not add our own `render-process-gone`
// listener: the focus lifecycle already owns that signal, and the identity keeps
// this module self-contained.
//
// Identity is (pid, creationTime), not the OS pid alone: an in-place reload's
// fresh renderer can be assigned the SAME pid as the dead one (Windows recycles
// freed pids aggressively), and bare-pid identity would then read "unchanged"
// and collapse back to the pre-fix silent-gap wedge. A reloaded renderer is a
// newly-spawned process, so its creationTime differs even when the pid repeats.
// This mirrors process-gone-diagnostics.ts, which pairs pid with creationTime
// for the same recycled-pid disambiguation. When creationTime is unavailable we
// fall back to pid equality (best effort).
//
// Coverage limit: Electron's `unresponsive` is driven by Chromium's input-ACK
// hang monitor, not a periodic ping — it only arms once an input event is
// dispatched to the renderer. A wholly idle/background freeze with no input may
// never surface `unresponsive`, so this captures interactive freezes (the field
// reports were) but not a silent background one; a heartbeat-gap watchdog would
// be the input-independent follow-up.

const RENDERER_UNRESPONSIVE_SAMPLE_INTERVAL_MS = 30_000
// Why: cap the per-hang samples so a wedged-but-alive renderer cannot force-flush
// the 30-entry breadcrumb ring full of flat samples and evict pre-hang context.
// 20 × 30s = 10 min comfortably covers the ~5-min field OOM curve; the recovery
// summary still carries peak/count/duration past the cap. The cap stops sample
// writes only — re-arming after a death does not depend on the timer surviving,
// so a post-cap crash-then-freeze is still captured (via onUnresponsive's identity check).
const RENDERER_UNRESPONSIVE_MAX_SAMPLES = 20

function numericDetail(details: CrashReportBreadcrumbData, key: string): number | null {
  const value: CrashReportDetailValue | undefined = details[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// Why filter to the frozen renderer's own pid: getAppMetrics sums working set
// across every renderer (browser tabs, popouts, agent webContents), so the
// unfiltered aggregate would read an unrelated busy tab's memory as this
// window's freeze curve. Scope to the one process that went unresponsive.
function collectFrozenRendererMetrics(resolvePid: () => number | null): CrashReportBreadcrumbData {
  try {
    const pid = resolvePid()
    const metrics = app.getAppMetrics()
    const own = pid !== null ? metrics.filter((metric) => metric.pid === pid) : []
    const details = collectProcessGoneMetricDetails(own)
    if (pid === null) {
      // Why: without a pid the numbers are unattributable; flag it so a triager
      // never reads a 0 or a fallback as the frozen renderer's real footprint.
      details.processMetricsFrozenRendererPidResolved = false
    } else if (own.length === 0) {
      // Why a distinct flag: the pid resolved but its row is absent from the live
      // table — the process vanished (died/rotated) or metrics lag. Same "don't
      // trust these zeros" signal, but a different, more interesting reason.
      details.processMetricsFrozenRendererAbsentFromMetrics = true
    }
    return details
  } catch (error) {
    // Why: this runs on a timer during a crash-adjacent freeze; a throw here must
    // not take down the main process or abort the hang record.
    return { processMetricsError: error instanceof Error ? error.name : typeof error }
  }
}

/**
 * Records durable breadcrumbs around Electron's renderer `unresponsive`/`responsive`
 * signals, sampling the frozen renderer's memory from the main process so the next
 * freeze-then-OOM shows its allocation curve instead of a silent heartbeat gap.
 */
export function installRendererUnresponsiveBreadcrumb(args: {
  window: BrowserWindow
  sampleIntervalMs?: number
  now?: () => number
  collectMetricsDetails?: () => CrashReportBreadcrumbData
}): { dispose: () => void } {
  const {
    window,
    sampleIntervalMs = RENDERER_UNRESPONSIVE_SAMPLE_INTERVAL_MS,
    now = () => Date.now()
  } = args
  // Why: capture the webContents reference at install so the sampling interval can
  // poll isCrashed()/getOSProcessId() without re-reading the `window.webContents`
  // getter, which throws once the window is destroyed.
  const webContents: WebContents = window.webContents

  const resolveRendererPid = (): number | null => {
    try {
      if (window.isDestroyed() || webContents.isDestroyed()) {
        return null
      }
      const pid = webContents.getOSProcessId()
      return typeof pid === 'number' && pid > 0 ? pid : null
    } catch {
      return null
    }
  }

  // (pid, creationTime): the pid identifies the OS process, creationTime the
  // process generation so a recycled pid (a fresh renderer reassigned the dead
  // one's pid) reads as a different renderer. creationTime is null when the row
  // is absent from getAppMetrics; comparison then degrades to pid equality.
  const resolveRendererIdentity = (): { pid: number; creationTime: number | null } | null => {
    const pid = resolveRendererPid()
    if (pid === null) {
      return null
    }
    try {
      const row = app.getAppMetrics().find((metric) => metric.pid === pid)
      const creationTime = row?.creationTime
      return {
        pid,
        creationTime: typeof creationTime === 'number' && Number.isFinite(creationTime) ? creationTime : null
      }
    } catch {
      return { pid, creationTime: null }
    }
  }

  // Same renderer generation iff same pid and (when both are known) same
  // creationTime. A null on either side is treated as "not the same": an
  // unresolved identity should re-arm onset detection rather than swallow a
  // possibly-reloaded renderer's fresh freeze.
  const isSameRendererGeneration = (
    a: { pid: number; creationTime: number | null } | null,
    b: { pid: number; creationTime: number | null } | null
  ): boolean => {
    if (a === null || b === null || a.pid !== b.pid) {
      return false
    }
    if (a.creationTime !== null && b.creationTime !== null) {
      return a.creationTime === b.creationTime
    }
    return true
  }

  const collectMetricsDetails =
    args.collectMetricsDetails ?? (() => collectFrozenRendererMetrics(resolveRendererPid))

  let hangStartMs: number | null = null
  let hangStartIdentity: { pid: number; creationTime: number | null } | null = null
  let sampleTimer: ReturnType<typeof setInterval> | null = null
  let sampleCount = 0
  let peakRendererWorkingSetMB = 0
  let peakRendererPrivateMB = 0

  const trackPeaks = (details: CrashReportBreadcrumbData): void => {
    const workingSet = numericDetail(details, 'processMetricsRendererWorkingSetMB')
    if (workingSet !== null) {
      peakRendererWorkingSetMB = Math.max(peakRendererWorkingSetMB, workingSet)
    }
    const priv = numericDetail(details, 'processMetricsRendererPrivateMB')
    if (priv !== null) {
      peakRendererPrivateMB = Math.max(peakRendererPrivateMB, priv)
    }
  }

  const stopSampling = (): void => {
    if (sampleTimer) {
      clearInterval(sampleTimer)
      sampleTimer = null
    }
  }

  const reset = (): void => {
    stopSampling()
    hangStartMs = null
    hangStartIdentity = null
    sampleCount = 0
    peakRendererWorkingSetMB = 0
    peakRendererPrivateMB = 0
  }

  const beginHang = (): void => {
    hangStartMs = now()
    hangStartIdentity = resolveRendererIdentity()
    sampleCount = 0
    peakRendererWorkingSetMB = 0
    peakRendererPrivateMB = 0
    const details = collectMetricsDetails()
    trackPeaks(details)
    recordDurableCrashBreadcrumb('renderer_unresponsive', {
      ...details,
      rendererUnresponsiveElapsedMs: 0
    })
    // Why: the freeze can allocate GBs and die before it ever recovers; keep
    // sampling from the still-live main process so the climb is on record.
    sampleTimer = setInterval(() => {
      if (hangStartMs === null) {
        stopSampling()
        return
      }
      // Why reset (not just stop) here: the tracked renderer is gone — the window
      // was destroyed, its webContents crashed, or (the common field path) it
      // OOM-died and reloaded in place as a new process. render-process-gone owns
      // the death record; clearing state re-arms onset detection for the reloaded
      // renderer instead of wedging it off. isDestroyed() is checked before
      // isCrashed() so the throwing call never runs post-destroy.
      if (window.isDestroyed() || webContents.isDestroyed() || webContents.isCrashed()) {
        reset()
        return
      }
      // A live renderer whose identity no longer matches the onset one is a
      // reloaded-in-place replacement (possibly reusing the dead pid) — reset so
      // its memory is not misattributed to the dead hang's clock.
      if (!isSameRendererGeneration(resolveRendererIdentity(), hangStartIdentity)) {
        reset()
        return
      }
      sampleCount += 1
      const sample = collectMetricsDetails()
      trackPeaks(sample)
      recordDurableCrashBreadcrumb('renderer_unresponsive_sample', {
        ...sample,
        rendererUnresponsiveElapsedMs: now() - hangStartMs,
        rendererUnresponsiveSampleIndex: sampleCount
      })
      if (sampleCount >= RENDERER_UNRESPONSIVE_MAX_SAMPLES) {
        stopSampling()
      }
    }, sampleIntervalMs)
    sampleTimer.unref?.()
  }

  const onUnresponsive = (): void => {
    if (hangStartMs !== null) {
      // Why: a renderer that OOM-died and reloaded in place reuses this same
      // webContents as a new process. If the tracked freeze belonged to that dead
      // renderer, its onset is stale — treat this as a fresh freeze rather than
      // dropping it as a duplicate (the silent-gap wedge). A matching identity
      // means a genuine duplicate for the still-frozen renderer, so ignore it.
      if (isSameRendererGeneration(resolveRendererIdentity(), hangStartIdentity)) {
        return
      }
      reset()
    }
    beginHang()
  }

  const onResponsive = (): void => {
    if (hangStartMs === null) {
      return
    }
    const elapsedMs = now() - hangStartMs
    const samplesTaken = sampleCount
    const peakWorkingSet = peakRendererWorkingSetMB
    const peakPrivate = peakRendererPrivateMB
    reset()
    recordDurableCrashBreadcrumb('renderer_responsive', {
      rendererUnresponsiveDurationMs: elapsedMs,
      rendererUnresponsiveSampleCount: samplesTaken,
      rendererUnresponsivePeakWorkingSetMB: peakWorkingSet,
      rendererUnresponsivePeakPrivateMB: peakPrivate
    })
  }

  window.on('unresponsive', onUnresponsive)
  window.on('responsive', onResponsive)

  return {
    dispose: () => {
      reset()
      window.removeListener('unresponsive', onUnresponsive)
      window.removeListener('responsive', onResponsive)
    }
  }
}
