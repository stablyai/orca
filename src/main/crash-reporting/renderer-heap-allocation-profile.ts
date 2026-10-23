import type { WebContents } from 'electron'
import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting'
import {
  RENDERER_HEAP_ALLOCATION_PROFILE_BREADCRUMB,
  recordCrashBreadcrumb
} from './crash-breadcrumb-store'
import {
  readSamplingProfile,
  summarizeSamplingProfile,
  trustedScriptPrefixFor
} from './renderer-heap-allocation-sites'

// Why 512 KB: V8's sampler then records ~2 stacks per MB allocated, cheap enough to leave on near OOM.
const SAMPLING_INTERVAL_BYTES = 512 * 1024
// Sampling runs while the heap is at least 60% full and stops once it falls below 50%.
const START_HEAP_RATIO = 0.6
const STOP_HEAP_RATIO = 0.5
// Why: main re-reads on its own clock, since a hidden window throttles the renderer's memory samples
// and a fast leak can go from 60% to OOM between two of them. Each read forces a full GC, so not often.
const PROFILE_REFRESH_MS = 30_000

export type ProfiledDebugger = {
  isAttached(): boolean
  attach(protocolVersion?: string): void
  detach(): void
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
  on(event: 'detach', listener: () => void): unknown
  removeListener(event: 'detach', listener: () => void): unknown
}

export type ProfiledRenderer = {
  id: number
  debugger: ProfiledDebugger
  isDestroyed(): boolean
  getURL(): string
  // Calls onEnd when the renderer is destroyed, its process dies, or it loads a new document.
  watchDocumentEnd(onEnd: () => void): () => void
}

export function profiledRendererFor(contents: WebContents): ProfiledRenderer {
  return {
    id: contents.id,
    debugger: contents.debugger,
    isDestroyed: () => contents.isDestroyed(),
    getURL: () => contents.getURL(),
    watchDocumentEnd: (onEnd) => {
      // Why: a new document starts with a fresh heap and its own high-water marks.
      const onNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
        if (details.isMainFrame && !details.isSameDocument) {
          onEnd()
        }
      }
      contents.on('destroyed', onEnd)
      contents.on('render-process-gone', onEnd)
      contents.on('did-start-navigation', onNavigation)
      return () => {
        contents.removeListener('destroyed', onEnd)
        contents.removeListener('render-process-gone', onEnd)
        contents.removeListener('did-start-navigation', onNavigation)
      }
    }
  }
}

/** One heap reading from a renderer crumb: a periodic sample or a high-water mark. */
export type RendererHeapReading = {
  heapRatio: number
  rendererSurface: string
  isHighwaterMark: boolean
}

type SamplingSession = {
  rendererSurface: string
  startedAtPct: number
  startedAtMs: number
  trustedScriptPrefix: string | null
  // Reads before startSampling resolves would fail, so they wait for it.
  ready: boolean
  reading: boolean
  stop: () => void
}

const sessions = new Map<number, SamplingSession>()

/**
 * Samples which code allocates the renderer heap while it is near its limit, and keeps the newest
 * summary in one retained crumb so a crash report names the allocation sites behind the growth.
 * Whether to sample is re-derived from every reading, so recovery or a reload releases the debugger.
 */
export function noteRendererHeapReading(
  renderer: ProfiledRenderer,
  reading: RendererHeapReading,
  record: (data: CrashReportBreadcrumbData) => void
): void {
  if (renderer.isDestroyed()) {
    return
  }
  const session = sessions.get(renderer.id)
  if (!session) {
    if (reading.heapRatio >= START_HEAP_RATIO) {
      startSampling(renderer, reading, record)
    }
    return
  }
  if (reading.heapRatio < STOP_HEAP_RATIO) {
    session.stop()
    return
  }
  if (reading.isHighwaterMark) {
    refreshProfile(renderer, session, record)
  }
}

function refreshProfile(
  renderer: ProfiledRenderer,
  session: SamplingSession,
  record: (data: CrashReportBreadcrumbData) => void
): void {
  if (!session.ready || session.reading) {
    return
  }
  session.reading = true
  void renderer.debugger
    .sendCommand('HeapProfiler.getSamplingProfile')
    .then((result) => {
      const profile = readSamplingProfile(result)
      if (profile && sessions.get(renderer.id) === session) {
        record({
          rendererSurface: session.rendererSurface,
          startedAtPct: session.startedAtPct,
          sampledMinutes: Math.round((Date.now() - session.startedAtMs) / 60_000),
          ...summarizeSamplingProfile(profile, session.trustedScriptPrefix)
        })
      }
    })
    .catch(() => undefined)
    .finally(() => {
      session.reading = false
    })
}

function startSampling(
  renderer: ProfiledRenderer,
  reading: RendererHeapReading,
  record: (data: CrashReportBreadcrumbData) => void
): void {
  const debug = renderer.debugger
  // Why: never take over a debugger someone else (DevTools, a diagnostic script) attached.
  if (debug.isAttached()) {
    return
  }
  try {
    debug.attach('1.3')
  } catch {
    return
  }
  let stopped = false
  let unwatch = (): void => undefined
  let refreshTimer: ReturnType<typeof setInterval> | undefined
  const stop = (): void => {
    if (stopped) {
      return
    }
    stopped = true
    clearInterval(refreshTimer)
    sessions.delete(renderer.id)
    debug.removeListener('detach', onDetach)
    unwatch()
    if (!renderer.isDestroyed() && debug.isAttached()) {
      void debug.sendCommand('HeapProfiler.stopSampling').catch(() => undefined)
      try {
        debug.detach()
      } catch {
        // Already gone with the renderer.
      }
    }
  }
  const onDetach = (): void => stop()
  debug.on('detach', onDetach)
  unwatch = renderer.watchDocumentEnd(stop)
  const session: SamplingSession = {
    rendererSurface: reading.rendererSurface,
    startedAtPct: Math.round(reading.heapRatio * 100),
    startedAtMs: Date.now(),
    trustedScriptPrefix: trustedScriptPrefixFor(renderer.getURL()),
    ready: false,
    reading: false,
    stop
  }
  sessions.set(renderer.id, session)
  void debug
    .sendCommand('HeapProfiler.enable')
    .then(() =>
      debug.sendCommand('HeapProfiler.startSampling', {
        samplingInterval: SAMPLING_INTERVAL_BYTES
      })
    )
    .then(() => {
      if (stopped) {
        return
      }
      session.ready = true
      refreshTimer = setInterval(
        () => refreshProfile(renderer, session, record),
        PROFILE_REFRESH_MS
      )
      refreshTimer.unref?.()
    })
    .catch(stop)
}

/** Feeds a renderer-sent memory crumb to the profiler. */
export function profileRendererMemoryBreadcrumb(
  renderer: ProfiledRenderer,
  args: { name?: unknown; data?: unknown } | undefined,
  origin: string
): void {
  const reading = readHeapReading(args)
  if (reading) {
    noteRendererHeapReading(renderer, reading, (data) => {
      recordCrashBreadcrumb(RENDERER_HEAP_ALLOCATION_PROFILE_BREADCRUMB, data, origin)
    })
  }
}

function readHeapReading(
  args: { name?: unknown; data?: unknown } | undefined
): RendererHeapReading | null {
  const isHighwaterMark = args?.name === 'renderer_memory_highwater'
  const data = args?.data
  if ((!isHighwaterMark && args?.name !== 'renderer_memory') || !data || typeof data !== 'object') {
    return null
  }
  const used = 'usedHeapMB' in data ? data.usedHeapMB : undefined
  const limit = 'heapLimitMB' in data ? data.heapLimitMB : undefined
  if (typeof used !== 'number' || typeof limit !== 'number' || !(limit > 0)) {
    return null
  }
  const surface = 'rendererSurface' in data ? data.rendererSurface : undefined
  return {
    heapRatio: used / limit,
    rendererSurface: typeof surface === 'string' ? surface : 'unknown',
    isHighwaterMark
  }
}

export function resetRendererHeapAllocationProfilesForTests(): void {
  for (const session of sessions.values()) {
    session.stop()
  }
  sessions.clear()
}
