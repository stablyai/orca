import type { BrowserWindow } from 'electron'
import {
  captureFullPageScreenshot,
  captureScreenshot,
  drawOwnedCaptureViewport,
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
  resizeOwnedCaptureFrame,
  waitForOwnedCaptureViewport,
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
    let restoreFrameSize: { width: number; height: number } | null = null
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
          if (
            request.kind === 'screenshot' &&
            request.params?.captureBeyondViewport === false &&
            !request.params.clip
          ) {
            const bounds = controller.record.view.getBounds()
            if (
              (bounds.width > 1 && viewport.width <= 1) ||
              (bounds.height > 1 && viewport.height <= 1)
            ) {
              const zoom = guest.getZoomFactor()
              if (!Number.isFinite(zoom) || zoom <= 0) {
                throw new Error('Owned browser capture zoom is unavailable')
              }
              // Set before sending: a timed-out command can still resize the frame later.
              restoreFrameSize = {
                width: Math.max(1, Math.round(viewport.width * zoom)),
                height: Math.max(1, Math.round(viewport.height * zoom))
              }
              const original = viewport
              await resizeOwnedCaptureFrame(guest, { width: bounds.width, height: bounds.height })
              await waitForOwnedCaptureViewport(guest, (current) => {
                if (
                  current.timeOrigin !== original.timeOrigin ||
                  current.devicePixelRatio !== original.devicePixelRatio ||
                  Math.abs(current.width * zoom - bounds.width) > 1 ||
                  Math.abs(current.height * zoom - bounds.height) > 1
                ) {
                  throw new Error(
                    `Owned browser frame did not synchronize: css=${current.width}x${current.height}, owned=${bounds.width}x${bounds.height}`
                  )
                }
              })
            }
            await drawOwnedCaptureViewport(guest)
          }
          // Native owned views support full-page CDP capture without resizing their CSS viewport.
          return request.kind === 'full-page'
            ? captureFullPageScreenshot(guest, request.format, holdPaint, reservation)
            : captureScreenshot(guest, request.params, holdPaint, reservation)
        },
        async () => {
          if (navigated) {
            throw new Error('Desktop-owned browser page navigated during capture')
          }
          if (restoreFrameSize) {
            await resizeOwnedCaptureFrame(guest, restoreFrameSize)
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
