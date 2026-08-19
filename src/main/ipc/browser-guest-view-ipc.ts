import { ipcMain } from 'electron'
import { browserManager } from '../browser/browser-manager'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'
import type { BrowserViewportOverride } from '../../shared/browser-workspace-types'
import {
  isValidBrowserAnnotationViewportBridgeMarkers,
  isValidBrowserAnnotationViewportBridgeToken,
  type BrowserSetAnnotationViewportBridgeArgs
} from '../../shared/browser-annotation-viewport-bridge'

export function registerBrowserGuestViewHandlers(): void {
  ipcMain.removeHandler('browser:openDevTools')
  ipcMain.removeHandler('browser:setViewportOverride')
  ipcMain.removeHandler('browser:setAnnotationViewportBridge')
  ipcMain.removeHandler('browser:acceptDownload')
  ipcMain.removeHandler('browser:cancelDownload')

  ipcMain.handle('browser:openDevTools', (event, args: { browserPageId: string }) => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return false
    }
    return browserManager.openDevTools(args.browserPageId)
  })

  ipcMain.handle(
    'browser:setViewportOverride',
    (
      event,
      args: {
        browserPageId: string
        override: BrowserViewportOverride | null
      }
    ) => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return false
      }
      // Why: CDP misbehaves on non-finite/negative metrics (NaN/Infinity can
      // wedge Emulation.setDeviceMetricsOverride and leave the page in a
      // broken state). Validate at the main-process trust boundary so a buggy
      // or compromised renderer cannot corrupt CDP state.
      if (args.override !== null) {
        const { width, height, deviceScaleFactor, mobile } = args.override
        const isFinitePositive = (n: unknown): n is number =>
          typeof n === 'number' && Number.isFinite(n) && n > 0
        if (!isFinitePositive(width) || width < 1 || width > 10000) {
          return false
        }
        if (!isFinitePositive(height) || height < 1 || height > 10000) {
          return false
        }
        if (
          !isFinitePositive(deviceScaleFactor) ||
          deviceScaleFactor < 0.1 ||
          deviceScaleFactor > 5
        ) {
          return false
        }
        if (typeof mobile !== 'boolean') {
          return false
        }
      }
      return browserManager.setViewportOverride(args.browserPageId, args.override)
    }
  )

  ipcMain.handle(
    'browser:setAnnotationViewportBridge',
    (event, args: BrowserSetAnnotationViewportBridgeArgs): Promise<boolean> | boolean => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return false
      }
      if (
        typeof args?.browserPageId !== 'string' ||
        typeof args.enabled !== 'boolean' ||
        typeof args.emitViewport !== 'boolean' ||
        !isValidBrowserAnnotationViewportBridgeMarkers(args.markers) ||
        !isValidBrowserAnnotationViewportBridgeToken(args.token)
      ) {
        return false
      }
      return browserManager.setAnnotationViewportBridge(args.browserPageId, {
        enabled: args.enabled,
        emitViewport: args.emitViewport,
        markers: args.markers,
        token: args.token
      })
    }
  )

  ipcMain.handle('browser:cancelDownload', (event, args: { downloadId: string }) => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return false
    }
    return browserManager.cancelDownload({
      downloadId: args.downloadId,
      senderWebContentsId: event.sender.id
    })
  })
}
