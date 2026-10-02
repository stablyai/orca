import { BrowserWindow, type Debugger, type WebContents } from 'electron'
import {
  runDebuggerCommandWithTimeout,
  sendDebuggerCommand
} from './browser-screencast-debugger-command'
import { sendGuestCdpCommand } from './guest-cdp-command'
import type { BrowserScreencastOptions } from './browser-screencast-stream-types'
import { positiveInteger, positiveNumber } from './browser-screencast-viewport-fit'

export type BrowserScreencastDeviceMetrics = {
  apply: () => Promise<void>
  clear: () => Promise<void>
  isOverridden: () => boolean
}

export function createBrowserScreencastDeviceMetrics(
  webContents: WebContents,
  dbg: Debugger,
  options: BrowserScreencastOptions
): BrowserScreencastDeviceMetrics {
  let deviceMetricsOverridden = false
  let originalSurfaceSize: { width: number; height: number } | null = null

  const resizeOffscreenSurface = (width: number, height: number): void => {
    if (!webContents.isOffscreen?.()) {
      return
    }
    const owner = BrowserWindow.fromWebContents(webContents)
    if (!owner || owner.isDestroyed()) {
      return
    }
    const [currentWidth, currentHeight] = owner.getContentSize()
    if (
      !originalSurfaceSize &&
      typeof currentWidth === 'number' &&
      typeof currentHeight === 'number'
    ) {
      originalSurfaceSize = { width: currentWidth, height: currentHeight }
    }
    if (currentWidth !== width || currentHeight !== height) {
      // CDP emulation alone does not resize the physical surface feeding live frames.
      owner.setContentSize(width, height)
    }
  }

  const restoreOffscreenSurface = (): void => {
    const original = originalSurfaceSize
    originalSurfaceSize = null
    if (!original || webContents.isDestroyed()) {
      return
    }
    const owner = BrowserWindow.fromWebContents(webContents)
    if (owner && !owner.isDestroyed()) {
      owner.setContentSize(original.width, original.height)
    }
  }
  const sendViewportCommand = (method: string, params: Record<string, unknown>): Promise<unknown> =>
    runDebuggerCommandWithTimeout(method, () => sendGuestCdpCommand(webContents, method, params))

  const clearDeviceMetricsOverride = async (): Promise<void> => {
    restoreOffscreenSurface()
    if (webContents.isDestroyed() || !dbg.isAttached()) {
      deviceMetricsOverridden = false
      return
    }
    await sendDebuggerCommand(dbg, 'Emulation.clearDeviceMetricsOverride')
    deviceMetricsOverridden = false
  }

  const applyDeviceMetricsOverride = async (): Promise<void> => {
    const viewportWidth = positiveInteger(options.viewportWidth)
    const viewportHeight = positiveInteger(options.viewportHeight)
    if (!viewportWidth || !viewportHeight) {
      if (deviceMetricsOverridden) {
        await clearDeviceMetricsOverride()
      }
      return
    }
    const deviceScaleFactor = positiveNumber(options.deviceScaleFactor) ?? 1
    resizeOffscreenSurface(viewportWidth, viewportHeight)
    // Why: Back/Forward and cross-process navigations can drop emulation while
    // the screencast remains attached. Reapply before fallback captures so the
    // page lays out at the client pane size, not the host BrowserView size.
    await sendViewportCommand('Emulation.setDeviceMetricsOverride', {
      width: viewportWidth,
      height: viewportHeight,
      deviceScaleFactor,
      mobile: options.mobile === true
    })
    await sendViewportCommand('Emulation.setVisibleSize', {
      width: viewportWidth,
      height: viewportHeight
    }).catch(() => {})
    deviceMetricsOverridden = true
  }

  return {
    apply: applyDeviceMetricsOverride,
    clear: clearDeviceMetricsOverride,
    isOverridden: () => deviceMetricsOverridden
  }
}
