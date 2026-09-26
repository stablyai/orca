import { app, type BrowserWindow, type WebContents } from 'electron'
import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting'
import { rendererCrashBreadcrumbOrigin } from '../../shared/crash-breadcrumb-origin'
import { recordDurableCrashBreadcrumb } from './durable-crash-breadcrumb'
import { collectProcessGoneMetricDetails } from './process-gone-diagnostics'

// Why: a renderer stuck in one long task stops its own timers, so its
// renderer_memory crumbs just stop until it OOMs. The main process stays live;
// it probes the renderer and, once the probe goes unanswered, records the
// looping JS stack and the renderer's memory so the crash report names the loop.
export const RENDERER_PROBE_INTERVAL_MS = 5_000
// Why ticks, not wall time: main timers also pause across system sleep, so a
// probe outstanding for two main-process ticks means the renderer, not the OS, stalled.
const HANG_PROBE_TICKS = 2
const RESAMPLE_EVERY_TICKS = 6
// Bounds ring pressure: onset + 7 resamples covers ~4 min, past the field OOM window.
const MAX_HANG_SAMPLES = 8
const STACK_TIMEOUT_MS = 3_000

type Hang = { startedAt: number; ticks: number; samples: number; lastStack: string | null }

/** Reduces file:// frames to the bundle file so install paths (user names) never reach reports. */
export function scrubJsCallStack(stack: string): string {
  // Greedy to the last '/': URL paths keep '(' unescaped (e.g. `Bob%20(Work)`), so stopping there leaks the rest.
  return stack.replace(/\bfile:\/\/\S*\/([^/\s()]+)/g, '$1').trim()
}

async function collectJsStack(webContents: WebContents): Promise<CrashReportBreadcrumbData> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // Resolves only once JS is running; a hang in native code (GC, layout) never answers.
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), STACK_TIMEOUT_MS)
    })
    const stack = await Promise.race([webContents.mainFrame.collectJavaScriptCallStack(), timeout])
    if (stack === 'timeout') {
      return { jsStackUnavailable: 'timeout' }
    }
    return typeof stack === 'string' && stack.trim()
      ? { jsStack: scrubJsCallStack(stack) }
      : { jsStackUnavailable: 'empty' }
  } catch (error) {
    return { jsStackUnavailable: error instanceof Error ? error.name : 'error' }
  } finally {
    clearTimeout(timer)
  }
}

function collectRendererMetrics(webContents: WebContents): CrashReportBreadcrumbData {
  try {
    // Only the hung renderer: getAppMetrics also lists browser guests and popouts.
    const pid = webContents.getOSProcessId()
    return collectProcessGoneMetricDetails(app.getAppMetrics().filter((m) => m.pid === pid))
  } catch (error) {
    return { processMetricsError: error instanceof Error ? error.name : 'error' }
  }
}

export function installRendererUnresponsiveBreadcrumb(window: BrowserWindow): {
  dispose: () => void
} {
  const webContents = window.webContents
  // Scoped to this renderer so popout and guest crash reports never carry the main window's hang.
  const origin = rendererCrashBreadcrumbOrigin(webContents.id)
  const record = (name: string, data: CrashReportBreadcrumbData): void =>
    recordDurableCrashBreadcrumb(name, data, undefined, origin)
  let probeToken = 0
  let probe: { token: number; ticks: number; pid: number } | null = null
  let hang: Hang | null = null
  let disposed = false

  const reset = (): void => {
    probe = null
    hang = null
  }

  const sample = async (current: Hang, name: string, extra: CrashReportBreadcrumbData) => {
    current.samples += 1
    const metrics = collectRendererMetrics(webContents)
    const stack = await collectJsStack(webContents)
    if (hang !== current) {
      return
    }
    const unchanged = stack.jsStack !== undefined && stack.jsStack === current.lastStack
    if (typeof stack.jsStack === 'string') {
      current.lastStack = stack.jsStack
    }
    record(name, {
      ...extra,
      ...metrics,
      ...(unchanged ? { jsStackUnchanged: true } : stack),
      rendererUnresponsiveElapsedMs: Date.now() - current.startedAt,
      rendererUnresponsiveSampleIndex: current.samples
    })
  }

  const beginHang = (trigger: 'probe' | 'unresponsive'): void => {
    if (hang || disposed) {
      return
    }
    hang = { startedAt: Date.now(), ticks: 0, samples: 0, lastStack: null }
    void sample(hang, 'renderer_unresponsive', { rendererUnresponsiveTrigger: trigger })
  }

  const endHang = (): void => {
    const ended = hang
    hang = null
    if (ended) {
      record('renderer_responsive', {
        rendererUnresponsiveDurationMs: Date.now() - ended.startedAt,
        rendererUnresponsiveSampleCount: ended.samples
      })
    }
  }

  const sendProbe = (): void => {
    const token = ++probeToken
    probe = { token, ticks: 0, pid: webContents.getOSProcessId() }
    // Runs only when the renderer main thread is free, so its answer is the liveness signal.
    webContents.executeJavaScript('0').then(
      () => {
        if (probe?.token === token) {
          probe = null
          endHang()
        }
      },
      () => {
        if (probe?.token === token) {
          probe = null
        }
      }
    )
  }

  const tick = (): void => {
    if (window.isDestroyed() || webContents.isDestroyed()) {
      dispose()
      return
    }
    // A crashed, reloading or replaced (new pid) renderer is a new generation; a DevTools breakpoint is not a hang.
    if (
      webContents.isCrashed() ||
      webContents.isLoadingMainFrame() ||
      webContents.isDevToolsOpened() ||
      (probe && probe.pid !== webContents.getOSProcessId())
    ) {
      reset()
      return
    }
    if (!probe) {
      sendProbe()
      return
    }
    probe.ticks += 1
    if (!hang) {
      if (probe.ticks >= HANG_PROBE_TICKS) {
        beginHang('probe')
      }
      return
    }
    hang.ticks += 1
    if (hang.ticks % RESAMPLE_EVERY_TICKS === 0 && hang.samples < MAX_HANG_SAMPLES) {
      void sample(hang, 'renderer_unresponsive_sample', {})
    }
  }

  // Chromium's input hang monitor can fire first when the user is interacting.
  const onUnresponsive = (): void => beginHang('unresponsive')
  const timer = setInterval(() => {
    try {
      tick()
    } catch (error) {
      // Diagnostic-only: a throwing Electron getter must never surface as a main-process error.
      console.warn('[crash-reporting] Renderer hang watchdog stopped', error)
      dispose()
    }
  }, RENDERER_PROBE_INTERVAL_MS)
  timer.unref?.()
  window.on('unresponsive', onUnresponsive)

  function dispose(): void {
    // No removeListener: this runs from the window's `closed`, which drops its listeners anyway.
    disposed = true
    clearInterval(timer)
    reset()
  }
  return { dispose }
}
