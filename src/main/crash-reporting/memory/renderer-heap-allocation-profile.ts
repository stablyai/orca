import type { WebContents } from 'electron'
import type { CrashReportBreadcrumbData } from '../../../shared/crash-reporting'
import {
  RENDERER_HEAP_ALLOCATION_PROFILE_BREADCRUMB,
  recordCrashBreadcrumb
} from '../breadcrumbs/crash-breadcrumb-store'
import {
  readSamplingProfile,
  summarizeSamplingProfile,
  trustedScriptPrefixFor
} from './renderer-heap-allocation-sites'

// A 512 KiB interval samples about two allocation stacks per MiB near OOM.
const SAMPLING_INTERVAL_BYTES = 512 * 1024
const START_HEAP_RATIO = 0.6
const STOP_HEAP_RATIO = 0.5
// Each profile read forces a full renderer GC, so read only after the heap has grown this much.
const PROFILE_READ_GROWTH_RATIO = 0.05
// Main checks heap growth itself because hidden renderers throttle memory samples.
const HEAP_CHECK_MS = 30_000

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
  watchDocumentEnd(onEnd: () => void): () => void
}

export function profiledRendererFor(contents: WebContents): ProfiledRenderer {
  return {
    id: contents.id,
    debugger: contents.debugger,
    isDestroyed: () => contents.isDestroyed(),
    getURL: () => contents.getURL(),
    watchDocumentEnd: (onEnd) => {
      // A new document has a fresh heap and high-water marks.
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

export type RendererHeapReading = {
  heapRatio: number
  heapLimitBytes: number
  rendererSurface: string
}

type SamplingSession = {
  rendererSurface: string
  startedAtPct: number
  startedAtMs: number
  trustedScriptPrefix: string | null
  heapLimitBytes: number
  // Highest heap ratio a read was admitted at; later reads need further growth.
  readHeapRatio: number
  // Null until startSampling resolves; profiles are only requested after that.
  readyAtMs: number | null
  profiled: boolean
  reading: boolean
  checking: boolean
  stop: () => void
}

const sessions = new Map<number, SamplingSession>()

/** Retain allocation-site evidence near the heap limit; release the debugger after recovery. */
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
  noteSessionHeapRatio(renderer, session, reading.heapRatio, record)
}

function noteSessionHeapRatio(
  renderer: ProfiledRenderer,
  session: SamplingSession,
  heapRatio: number,
  record: (data: CrashReportBreadcrumbData) => void
): void {
  if (heapRatio < STOP_HEAP_RATIO) {
    session.stop()
    return
  }
  if (session.readyAtMs === null || session.reading) {
    return
  }
  // Without growth, still take one profile after a check interval so a steady high heap has evidence.
  const firstReadDue = !session.profiled && Date.now() - session.readyAtMs >= HEAP_CHECK_MS
  if (!firstReadDue && heapRatio < session.readHeapRatio + PROFILE_READ_GROWTH_RATIO) {
    return
  }
  // Admission, not success, consumes the allowance: a failed read may already have paid for its GC.
  session.profiled = true
  session.readHeapRatio = Math.max(session.readHeapRatio, heapRatio)
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
  // Only sees Orca's own debugger client (the lag capture); other CDP sessions are not visible here.
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
  let heapCheckTimer: ReturnType<typeof setInterval> | undefined
  const stop = (): void => {
    if (stopped) {
      return
    }
    stopped = true
    clearInterval(heapCheckTimer)
    sessions.delete(renderer.id)
    debug.removeListener('detach', onDetach)
    unwatch()
    if (!renderer.isDestroyed() && debug.isAttached()) {
      // Detaching ends the inspector session, which stops sampling without stopSampling's forced GC.
      try {
        debug.detach()
      } catch {
        // Renderer teardown can race debugger detachment.
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
    heapLimitBytes: reading.heapLimitBytes,
    readHeapRatio: reading.heapRatio,
    readyAtMs: null,
    profiled: false,
    reading: false,
    checking: false,
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
      session.readyAtMs = Date.now()
      heapCheckTimer = setInterval(() => checkHeap(renderer, session, record), HEAP_CHECK_MS)
      heapCheckTimer.unref?.()
    })
    .catch(stop)
}

function checkHeap(
  renderer: ProfiledRenderer,
  session: SamplingSession,
  record: (data: CrashReportBreadcrumbData) => void
): void {
  if (session.checking) {
    return
  }
  session.checking = true
  // Runtime.getHeapUsage reads heap statistics without collecting garbage.
  void renderer.debugger
    .sendCommand('Runtime.getHeapUsage')
    .then((result) => {
      const used =
        result && typeof result === 'object' && 'usedSize' in result ? result.usedSize : undefined
      if (
        typeof used === 'number' &&
        Number.isFinite(used) &&
        sessions.get(renderer.id) === session
      ) {
        noteSessionHeapRatio(renderer, session, used / session.heapLimitBytes, record)
      }
    })
    .catch(() => undefined)
    .finally(() => {
      session.checking = false
    })
}

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
  const data = args?.data
  if (
    (args?.name !== 'renderer_memory_highwater' && args?.name !== 'renderer_memory') ||
    !data ||
    typeof data !== 'object'
  ) {
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
    heapLimitBytes: limit * 1024 * 1024,
    rendererSurface: typeof surface === 'string' ? surface : 'unknown'
  }
}

export function resetRendererHeapAllocationProfilesForTests(): void {
  for (const session of sessions.values()) {
    session.stop()
  }
  sessions.clear()
}
