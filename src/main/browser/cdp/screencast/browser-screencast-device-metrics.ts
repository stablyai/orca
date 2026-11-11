import type { Debugger, WebContents } from 'electron'
import {
  runDebuggerCommandWithTimeout,
  sendDebuggerCommand
} from './browser-screencast-debugger-command'
import { sendGuestCdpCommand } from '../debugger/guest-cdp-command'
import { touchEmulationParams } from '../input/guest-touch-emulation'
import type { BrowserScreencastGuestViewSize } from './browser-screencast-guest-view-limit'
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
  options: BrowserScreencastOptions,
  getRestoreVisibleSize?: () => BrowserScreencastGuestViewSize | null
): BrowserScreencastDeviceMetrics {
  let deviceMetricsOverridden = false
  let mobileTouchOverridden = false
  const sendViewportCommand = (method: string, params: Record<string, unknown>): Promise<unknown> =>
    runDebuggerCommandWithTimeout(method, () => sendGuestCdpCommand(webContents, method, params))

  const clearDeviceMetricsOverride = async (): Promise<void> => {
    if (webContents.isDestroyed() || !dbg.isAttached()) {
      deviceMetricsOverridden = false
      mobileTouchOverridden = false
      return
    }
    await sendDebuggerCommand(dbg, 'Emulation.clearDeviceMetricsOverride')
    if (mobileTouchOverridden) {
      mobileTouchOverridden = false
      await sendViewportCommand(
        'Emulation.setTouchEmulationEnabled',
        touchEmulationParams(false)
      ).catch(() => {})
    }
    const restoreSize = getRestoreVisibleSize?.()
    if (restoreSize && restoreSize.width > 0 && restoreSize.height > 0) {
      await sendViewportCommand('Emulation.setVisibleSize', {
        width: restoreSize.width,
        height: restoreSize.height
      }).catch(() => {})
    }
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
    const isMobile = options.mobile === true
    // Navigation can drop emulation; restore client viewport metrics before fallback captures.
    await sendViewportCommand('Emulation.setDeviceMetricsOverride', {
      width: viewportWidth,
      height: viewportHeight,
      deviceScaleFactor,
      mobile: isMobile
    })
    if (isMobile) {
      mobileTouchOverridden = true
    }
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
