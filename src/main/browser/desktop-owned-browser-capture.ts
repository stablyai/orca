import type { BrowserWindow } from 'electron'
import {
  captureFullPageScreenshot,
  captureScreenshot,
  type CapturePaintHold
} from './cdp-screenshot'
import { acquireElectronDebugger, type ElectronDebuggerLease } from './electron-debugger-lease'
import type { DesktopOwnedBrowserView } from './desktop-owned-browser-view'
import {
  registerDesktopOwnedBrowserCapture,
  type DesktopOwnedBrowserCaptureRequest
} from './desktop-owned-browser-capture-registry'
import {
  readOwnedCaptureViewportState,
  restoreOwnedCaptureViewport,
  type OwnedCaptureViewport
} from './desktop-owned-browser-capture-state'

export class DesktopOwnedBrowserCapture {
  private readonly registered = new Set<DesktopOwnedBrowserView>()

  register(controller: DesktopOwnedBrowserView, owner: BrowserWindow): () => void {
    const unregister = registerDesktopOwnedBrowserCapture(controller.record, (request, holdPaint) =>
      this.capture(controller, owner, request, holdPaint)
    )
    this.registered.add(controller)
    return () => {
      unregister()
      this.registered.delete(controller)
    }
  }

  private async capture(
    controller: DesktopOwnedBrowserView,
    owner: BrowserWindow,
    request: DesktopOwnedBrowserCaptureRequest,
    holdPaint: CapturePaintHold
  ): Promise<{ data: string }> {
    const { webContents: guest } = controller.record
    const debuggerState: { lease: ElectronDebuggerLease | null } = { lease: null }
    let viewport: OwnedCaptureViewport | null = null
    let navigated = false
    const navigation = (
      event: Electron.Event & { isMainFrame: boolean; isSameDocument: boolean }
    ): void => {
      if (event.isMainFrame && !event.isSameDocument) {
        navigated = true
      }
    }
    try {
      return await controller.withStableView(
        async (reservation) => {
          if (!this.registered.has(controller) || owner.isDestroyed()) {
            throw new Error('Desktop-owned browser capture owner is unavailable')
          }
          debuggerState.lease = acquireElectronDebugger(guest)
          guest.on('did-start-navigation', navigation)
          viewport = await readOwnedCaptureViewportState(guest)
          // Native owned views support full-page CDP capture without resizing their CSS viewport.
          return request.kind === 'full-page'
            ? captureFullPageScreenshot(guest, request.format, holdPaint, reservation)
            : captureScreenshot(guest, request.params, holdPaint, reservation)
        },
        async () => {
          if (navigated) {
            throw new Error('Desktop-owned browser page navigated during capture')
          }
          if (viewport) {
            await restoreOwnedCaptureViewport(guest, viewport)
          }
        }
      )
    } finally {
      guest.removeListener('did-start-navigation', navigation)
      debuggerState.lease?.release()
    }
  }
}
