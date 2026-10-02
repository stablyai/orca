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
  let metricsGeneration = 0
  let originalSurfaceSize: { width: number; height: number } | null = null

  const resizeOffscreenSurface = (width: number, height: number): void => {
    if (webContents.isDestroyed() || webContents.isCrashed() || !webContents.isOffscreen?.()) {
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
    if (!original || webContents.isDestroyed() || webContents.isCrashed()) {
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
    metricsGeneration += 1
    restoreOffscreenSurface()
    deviceMetricsOverridden = false
    if (webContents.isDestroyed() || webContents.isCrashed() || !dbg.isAttached()) {
      return
    }
    await sendDebuggerCommand(dbg, 'Emulation.clearDeviceMetricsOverride')
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
    const generation = metricsGeneration
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
    // A late CDP reply must not reclaim a surface released during debugger detach.
    if (generation !== metricsGeneration || !dbg.isAttached()) {
      return
    }
    deviceMetricsOverridden = true
    await sendViewportCommand('Emulation.setVisibleSize', {
      width: viewportWidth,
      height: viewportHeight
    }).catch(() => {})
  }

  return {
    apply: applyDeviceMetricsOverride,
    clear: clearDeviceMetricsOverride,
    isOverridden: () => deviceMetricsOverridden || originalSurfaceSize !== null
  }
}
