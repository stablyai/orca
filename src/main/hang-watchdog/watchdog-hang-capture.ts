import { createNativeHangCaptureId, NativeHangCaptureStore } from './native-hang-capture-store'
import type { NativeHangProcessMetadata } from './native-hang-report'
import type { HangObservation } from './hang-observations'

type CaptureOwner = {
  id: string
  reason?: 'recovery' | 'shutdown'
  stop?: (reason: 'recovery' | 'shutdown') => void
}

export function createWatchdogHangCapture(options: {
  parentPid: number
  artifactDirectory?: string
  processMetadata?: NativeHangProcessMetadata
  publish: (id: string, change: Partial<HangObservation>) => void
  drain: (token: string) => Promise<void>
  onIdle: () => void
}): {
  capture: (record: HangObservation, detectedAt: number, showMenuBarIcon: boolean | null) => void
  recover: (id: string) => void
  shutdown: () => void
} {
  let stopped = false
  let jsOwner: CaptureOwner | null = null
  let nativeOwner: CaptureOwner | null = null
  const store = options.artifactDirectory
    ? new NativeHangCaptureStore(options.artifactDirectory)
    : null
  const idle = (): void => {
    if (stopped && !jsOwner && !nativeOwner) {
      options.onIdle()
    }
  }
  const capture = (
    record: HangObservation,
    detectedAt: number,
    showMenuBarIcon: boolean | null
  ): void => {
    if (stopped || record.kind !== 'heartbeat-stall') {
      return
    }
    let nativeStarted: Promise<void> = Promise.resolve()
    if (process.platform === 'darwin' && !nativeOwner) {
      const owner: CaptureOwner = { id: record.id }
      nativeOwner = owner
      const captureId = createNativeHangCaptureId(record.detectedAt)
      const metadata = options.processMetadata
      nativeStarted = import('./native-hang-capture')
        .then((native) => {
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
          owner.stop = () => child.stop()
          if (owner.reason === 'shutdown') {
            child.stop()
          }
          void child.done.finally(() => {
            if (nativeOwner === owner) {
              nativeOwner = null
            }
            idle()
          })
          return child.started
        })
        .catch(() => {
          if (nativeOwner === owner) {
            nativeOwner = null
          }
          idle()
        })
    }
    if (!jsOwner) {
      const owner: CaptureOwner = { id: record.id }
      jsOwner = owner
      void (async () => {
        await nativeStarted
        const [inspector, js] = await Promise.all([
          import('node:inspector'),
          import('./main-js-hang-capture')
        ])
        const mainJs = js.captureMainJsHang({
          session: new inspector.Session(),
          detectedAt,
          now: () => performance.now(),
          publish: (mainJs) => options.publish(record.id, { mainJs }),
          drain: () => options.drain(record.id)
        })
        owner.stop = mainJs.stop
        if (owner.reason) {
          mainJs.stop(owner.reason)
        }
        await mainJs.done
      })()
        .catch(() => {})
        .finally(() => {
          if (jsOwner === owner) {
            jsOwner = null
          }
          idle()
        })
    }
  }
  return {
    capture,
    recover: (id) => {
      if (jsOwner?.id === id) {
        jsOwner.reason ??= 'recovery'
        jsOwner.stop?.('recovery')
      }
    },
    shutdown: () => {
      stopped = true
      for (const owner of [jsOwner, nativeOwner]) {
        if (owner) {
          owner.reason ??= 'shutdown'
          owner.stop?.('shutdown')
        }
      }
      idle()
    }
  }
}
