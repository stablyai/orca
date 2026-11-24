import { createNativeHangCaptureId, NativeHangCaptureStore } from './native-hang-capture-store'
import type { NativeHangProcessMetadata } from './native-hang-report'
import type { HangObservation } from './hang-observations'

type NativeCaptureOwner = { stop?: () => void }

export function createWatchdogHangCapture(options: {
  parentPid: number
  artifactDirectory?: string
  processMetadata?: NativeHangProcessMetadata
  publish: (id: string, change: Partial<HangObservation>) => void
  onIdle: () => void
}): {
  capture: (record: HangObservation, showMenuBarIcon: boolean | null) => void
  shutdown: () => void
} {
  let stopped = false
  let activeCapture: NativeCaptureOwner | null = null
  const store = options.artifactDirectory
    ? new NativeHangCaptureStore(options.artifactDirectory)
    : null
  return {
    capture: (record, showMenuBarIcon) => {
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
      void import('./native-hang-capture')
        .then((native) => {
          if (stopped) {
            return
          }
          const captureId = createNativeHangCaptureId(record.detectedAt)
          const metadata = options.processMetadata
          const child = native.captureNativeHang({
            pid: options.parentPid,
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
                  process: metadata,
                  report
                })
              }
            }
          })
          owner.stop = child.stop
          return child.done
        })
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
      if (activeCapture) {
        activeCapture.stop?.()
      } else {
        options.onIdle()
      }
    }
  }
}
