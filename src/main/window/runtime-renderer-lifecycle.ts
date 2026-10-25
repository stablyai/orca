import type { WebContents } from 'electron'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { nativeDesktopWindowGraphs } from '../runtime/native-desktop-window-graphs'
import {
  beginNativeDesktopNotifierReloadFence,
  flushNativeDesktopNotifier,
  markNativeDesktopNotifierUnready,
  restoreNativeDesktopNotifierReady
} from './native-desktop-notifiers'
import { registerRendererDocumentNavigation } from './renderer-document-navigation'
import type { createRuntimeRendererNotificationSender } from './runtime-renderer-notification-sender'

export function registerRuntimeRendererLifecycle({
  webContents,
  runtime,
  windowId,
  native,
  notifications,
  setAvailable
}: {
  webContents: Pick<WebContents, 'getURL' | 'isLoadingMainFrame' | 'on'>
  runtime: OrcaRuntimeService
  windowId: number
  native: boolean
  notifications: ReturnType<typeof createRuntimeRendererNotificationSender>
  setAvailable: (available: boolean) => void
}): void {
  registerRendererDocumentNavigation(webContents, () => {
    setAvailable(false)
    notifications.onMainFrameReloadStarted()
    const resumeNativeGraph = native ? nativeDesktopWindowGraphs(runtime).suspend(windowId) : null
    if (native) {
      beginNativeDesktopNotifierReloadFence(runtime, windowId)
    }
    const fence = native ? null : runtime.markRendererReloading(windowId)
    return () => {
      if (native || (fence && runtime.markRendererReloadCancelled(windowId, fence))) {
        resumeNativeGraph?.()
        setAvailable(true)
        notifications.onMainFrameReloadCancelled()
        if (native) {
          restoreNativeDesktopNotifierReady(runtime, windowId)
        }
      }
    }
  })
  webContents.on('did-frame-navigate', (_event, _url, _code, _status, isMainFrame) => {
    if (native && isMainFrame) {
      markNativeDesktopNotifierUnready(runtime, windowId)
    }
  })
  webContents.on('did-finish-load', () => {
    setAvailable(true)
    notifications.onMainFrameLoadFinished()
    if (native) {
      flushNativeDesktopNotifier(runtime, windowId)
    }
  })
  webContents.on('render-process-gone', () => {
    setAvailable(false)
    notifications.onRendererProcessGone()
    if (native) {
      markNativeDesktopNotifierUnready(runtime, windowId)
    }
  })
}
