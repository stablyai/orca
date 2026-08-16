import type { Debugger, WebContents } from 'electron'
import { sendDebuggerCommand } from './browser-screencast-debugger-command'
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

  const clearDeviceMetricsOverride = async (): Promise<void> => {
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
      return
    }
    const deviceScaleFactor = positiveNumber(options.deviceScaleFactor) ?? 1
    // Why: Back/Forward and cross-process navigations can drop emulation while
    // the screencast remains attached. Reapply before fallback captures so the
    // page lays out at the client pane size, not the host BrowserView size.
    await sendDebuggerCommand(dbg, 'Emulation.setDeviceMetricsOverride', {
      width: viewportWidth,
      height: viewportHeight,
      deviceScaleFactor,
      mobile: options.mobile === true
    })
    await sendDebuggerCommand(dbg, 'Emulation.setVisibleSize', {
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
