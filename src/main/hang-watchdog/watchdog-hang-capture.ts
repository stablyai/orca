import type { MenuBarHost } from '../tray/mac-menu-bar-host'
import { createNativeHangCaptureId, NativeHangCaptureStore } from './native-hang-capture-store'
import type { NativeHangProcessMetadata } from './native-hang-report'
import type { HangObservation } from './hang-observations'
import type { captureNativeHang } from './native-hang-capture'
import type { runProcess } from '@orca/process-host'

type NativeCaptureOwner = { stop?: () => void }
type NativeCaptureModule = { captureNativeHang: typeof captureNativeHang }
type ProcessHostModule = { runProcess: typeof runProcess }
// After startup's busiest stretch, well before a user could hit a hang.
const PRELOAD_DELAY_MS = 30_000
let preloaded: { native: NativeCaptureModule; host: ProcessHostModule } | null = null

/** Loads capture code early: a module load during a hang needs the disk and thread pool main may be blocking. */
export function preloadHangCaptureModules(): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    // Enrichment runs everywhere; the native sample (and its process host) is macOS-only, so load it only there.
    void import('./hang-incident-snapshot').catch(() => {})
    if (process.platform !== 'darwin') {
      return
    }
    void Promise.all([import('./native-hang-capture'), import('@orca/process-host')])
      .then(([native, host]) => {
        preloaded = { native, host }
      })
      .catch(() => {})
  }, PRELOAD_DELAY_MS)
  timer.unref?.()
  return timer
}

/** What the menu-bar icon looked like when a hang is captured. */
export type MenuBarCaptureState = {
  showMenuBarIcon: boolean | null
  menuBarHost: MenuBarHost | null
}

export function createWatchdogHangCapture(options: {
  parentPid: number
  artifactDirectory?: string
  processMetadata?: NativeHangProcessMetadata
  publish: (id: string, change: Partial<HangObservation>) => void
  onIdle: () => void
}): {
  capture: (record: HangObservation, menuBar: MenuBarCaptureState) => void
  shutdown: () => void
} {
  let stopped = false
  let activeCapture: NativeCaptureOwner | null = null
  const preload = preloadHangCaptureModules()
  const store = options.artifactDirectory
    ? new NativeHangCaptureStore(options.artifactDirectory)
    : null
  return {
    capture: (record, { showMenuBarIcon, menuBarHost }) => {
      if (
        stopped ||
        activeCapture ||
        process.platform !== 'darwin' ||
        record.kind !== 'heartbeat-stall'
      ) {
        return
      }
      const owner: NativeCaptureOwner = {}
      activeCapture = owner
      // V8 profiler startup runs on the stalled main thread and can wedge it.
      const start = (native: NativeCaptureModule, host?: ProcessHostModule): Promise<void> => {
        if (stopped) {
          return Promise.resolve()
        }
        const captureId = createNativeHangCaptureId(record.detectedAt)
        const metadata = options.processMetadata
        const child = native.captureNativeHang({
          pid: options.parentPid,
          runProcess: host?.runProcess,
          publish: (native) => options.publish(record.id, { native }),
          completeReport: (report) => {
            if (store && metadata) {
              void store.save({
                version: 1,
                captureId,
                detectedAt: record.detectedAt,
                capturedAt: Date.now(),
                pid: options.parentPid,
                showMenuBarIcon,
                menuBarHost,
                process: metadata,
                report
              })
            }
          }
        })
        owner.stop = child.stop
        return child.done
      }
      // Preloaded: spawn sample now, synchronously, ahead of the caller's marker write.
      void (
        preloaded
          ? start(preloaded.native, preloaded.host)
          : import('./native-hang-capture').then(start)
      )
        .catch(() => {})
        .finally(() => {
          activeCapture = null
          if (stopped) {
            options.onIdle()
          }
        })
    },
    shutdown: () => {
      stopped = true
      clearTimeout(preload)
      if (activeCapture) {
        activeCapture.stop?.()
      } else {
        options.onIdle()
      }
    }
  }
}
