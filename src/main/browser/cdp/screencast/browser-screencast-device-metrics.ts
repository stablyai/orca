import { BrowserWindow, type Debugger, type WebContents } from 'electron'
import {
  runDebuggerCommandWithTimeout,
  sendDebuggerCommand
} from './browser-screencast-debugger-command'
import { sendGuestCdpCommand } from '../debugger/guest-cdp-command'
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
  const surface = webContents.isOffscreen() ? BrowserWindow.fromWebContents(webContents) : null
  let originalSurfaceSize: [number, number] | null = null

  const sendViewportCommand = (method: string, params: Record<string, unknown>): Promise<unknown> =>
    runDebuggerCommandWithTimeout(method, () => sendGuestCdpCommand(webContents, method, params))

  const clearDeviceMetricsOverride = async (): Promise<void> => {
    metricsGeneration += 1
    const original = originalSurfaceSize
    originalSurfaceSize = null
    deviceMetricsOverridden = false
    if (webContents.isDestroyed() || webContents.isCrashed()) {
      return
    }
    if (original && surface) {
      surface.setContentSize(...original)
    }
    if (!dbg.isAttached()) {
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
    if (surface && !webContents.isDestroyed() && !webContents.isCrashed()) {
      const currentSize = surface.getContentSize()
      originalSurfaceSize ??= [currentSize[0], currentSize[1]]
      if (currentSize[0] !== viewportWidth || currentSize[1] !== viewportHeight) {
        // CDP emulation alone does not resize the physical surface feeding live frames.
        surface.setContentSize(viewportWidth, viewportHeight)
      }
    }
    // Navigation can drop emulation; restore client viewport metrics before fallback captures.
    await sendViewportCommand('Emulation.setDeviceMetricsOverride', {
      width: viewportWidth,
      height: viewportHeight,
      deviceScaleFactor,
      mobile: options.mobile === true
    })
    // A late CDP reply must not reclaim a surface released during debugger detach.
    if (generation !== metricsGeneration) {
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
