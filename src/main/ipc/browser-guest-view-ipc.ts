import { ipcMain, webContents, type IpcMainInvokeEvent } from 'electron'
import { browserManager } from '../browser/browser-manager'
import { browserSiteDisplayController } from '../browser/browser-site-display-controller'
import { isBrowserPageZoomDirection } from '../../shared/browser-page-zoom'
import { publishBrowserClientPageMetadata } from '../browser/browser-client-page-metadata-transport'
import {
  BrowserClientPageMetadataParams,
  type BrowserClientPageMetadataPublishOutcome
} from '../../shared/browser-client-page-metadata-protocol'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime/remote-runtime-client-error'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'
import type { BrowserViewportOverride } from '../../shared/browser-workspace-types'
import { isValidBrowserGrabRect } from '../../shared/browser-annotation-viewport-report'
import {
  isBrowserSiteColorScheme,
  type BrowserPageSiteDisplay
} from '../../shared/browser-site-display'
import {
  isValidBrowserAnnotationViewportBridgeMarkers,
  isValidBrowserAnnotationViewportBridgeToken,
  type BrowserSetAnnotationViewportBridgeArgs
} from '../../shared/browser-annotation-viewport-bridge'

function isPagePoint(value: unknown): value is { x: number; y: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'x' in value &&
    'y' in value &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y)
  )
}

export function registerBrowserGuestViewHandlers(): void {
  ipcMain.removeHandler('browser:openDevTools')
  ipcMain.removeHandler('browser:closeDevTools')
  ipcMain.removeHandler('browser:setDevToolsDockBounds')
  ipcMain.removeHandler('browser:addWordToDictionary')
  ipcMain.removeHandler('browser:copyImageAt')
  ipcMain.removeHandler('browser:setViewportOverride')
  ipcMain.removeAllListeners?.('browser:reportViewportScrollState')
  ipcMain.removeHandler('browser:setAnnotationViewportBridge')
  ipcMain.removeHandler('browser:acceptDownload')
  ipcMain.removeHandler('browser:cancelDownload')
  ipcMain.removeHandler('browser:publishClientPageMetadata')
  ipcMain.removeHandler('browser:getPageSiteDisplay')
  ipcMain.removeHandler('browser:zoomPage')
  ipcMain.removeHandler('browser:setPageSiteColorScheme')
  ipcMain.removeHandler('browser:setPageAudioMuted')

  // Page/session operations exclude document previews.
  const pageGuestId = (event: IpcMainInvokeEvent, browserPageId: unknown): number | null =>
    isTrustedBrowserRenderer(event.sender) && typeof browserPageId === 'string'
      ? browserManager.getGuestWebContentsId(browserPageId)
      : null

  const pageGuest = (
    event: IpcMainInvokeEvent,
    browserPageId: unknown
  ): Electron.WebContents | null => {
    const guestId = pageGuestId(event, browserPageId)
    const guest = guestId === null ? undefined : webContents.fromId(guestId)
    return guest && !guest.isDestroyed() ? guest : null
  }

  ipcMain.handle(
    'browser:getPageSiteDisplay',
    (event, args: { browserPageId: string }): BrowserPageSiteDisplay | null => {
      const guestId = pageGuestId(event, args?.browserPageId)
      return guestId === null ? null : browserSiteDisplayController.getPageDisplay(guestId)
    }
  )

  ipcMain.handle(
    'browser:zoomPage',
    (event, args: { browserPageId: string; direction: unknown }): BrowserPageSiteDisplay | null => {
      const guestId = pageGuestId(event, args?.browserPageId)
      const { direction } = args
      if (guestId === null || !isBrowserPageZoomDirection(direction)) {
        return null
      }
      return browserSiteDisplayController.zoomPage(guestId, direction)
    }
  )

  ipcMain.handle(
    'browser:setPageSiteColorScheme',
    (
      event,
      args: { browserPageId: string; colorScheme: unknown }
    ): BrowserPageSiteDisplay | null => {
      const guestId = pageGuestId(event, args?.browserPageId)
      const { colorScheme } = args
      if (guestId === null || (colorScheme !== null && !isBrowserSiteColorScheme(colorScheme))) {
        return null
      }
      return browserSiteDisplayController.setColorScheme(guestId, colorScheme)
    }
  )

  ipcMain.handle(
    'browser:setPageAudioMuted',
    (event, args: { browserPageId: string; muted: unknown }): boolean => {
      const guest = pageGuest(event, args?.browserPageId)
      if (!guest || typeof args.muted !== 'boolean') {
        return false
      }
      guest.setAudioMuted(args.muted)
      return true
    }
  )

  ipcMain.handle(
    'browser:openDevTools',
    (event, args: { browserPageId: string; inspectAt?: unknown; detach?: unknown }) => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return false
      }
      return browserManager.openDevTools(
        args.browserPageId,
        isPagePoint(args.inspectAt) ? args.inspectAt : undefined,
        { detach: args.detach === true }
      )
    }
  )

  ipcMain.handle('browser:closeDevTools', (event, args: { browserPageId: unknown }): void => {
    if (isTrustedBrowserRenderer(event.sender) && typeof args?.browserPageId === 'string') {
      browserManager.closeDevTools(args.browserPageId)
    }
  })

  ipcMain.handle(
    'browser:setDevToolsDockBounds',
    (
      event,
      args: { browserPageId: unknown; bounds: unknown; snapshot?: unknown }
    ): Promise<string | null> | null => {
      if (!isTrustedBrowserRenderer(event.sender) || typeof args?.browserPageId !== 'string') {
        return null
      }
      return browserManager.setDevToolsDockBounds(
        args.browserPageId,
        isValidBrowserGrabRect(args.bounds) ? args.bounds : null,
        args.snapshot === true
      )
    }
  )

  ipcMain.handle(
    'browser:addWordToDictionary',
    (event, args: { browserPageId: string; word: unknown }): boolean => {
      const guest = pageGuest(event, args?.browserPageId)
      if (!guest || typeof args.word !== 'string' || !args.word) {
        return false
      }
      return guest.session.addWordToSpellCheckerDictionary(args.word)
    }
  )

  ipcMain.handle(
    'browser:copyImageAt',
    (event, args: { browserPageId: string; point: unknown }): boolean => {
      const guest = pageGuest(event, args?.browserPageId)
      if (!guest || !isPagePoint(args.point)) {
        return false
      }
      guest.copyImageAt(args.point.x, args.point.y)
      return true
    }
  )

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
      // Reject non-finite or negative renderer metrics before they can wedge CDP emulation.
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

  ipcMain.on?.(
    'browser:reportViewportScrollState',
    (
      event,
      args: {
        browserPageId?: unknown
        state?: {
          scrollLeft?: unknown
          scrollTop?: unknown
          maxScrollLeft?: unknown
          maxScrollTop?: unknown
        }
      }
    ) => {
      if (!isTrustedBrowserRenderer(event.sender) || typeof args?.browserPageId !== 'string') {
        return
      }
      const state = args.state
      if (!state) {
        return
      }
      browserManager.setViewportScrollState(args.browserPageId, event.sender.id, {
        scrollLeft: Number(state.scrollLeft),
        scrollTop: Number(state.scrollTop),
        maxScrollLeft: Number(state.maxScrollLeft),
        maxScrollTop: Number(state.maxScrollTop)
      })
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
        (args.selectionId !== undefined &&
          (typeof args.selectionId !== 'string' || args.selectionId.length > 80)) ||
        !isValidBrowserAnnotationViewportBridgeToken(args.token)
      ) {
        return false
      }
      // Tools may target documents too; authority resolution binds either guest to its owning renderer.
      const resolveGuest = (): Electron.WebContents | null =>
        browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id)
      if (!resolveGuest()) {
        return false
      }
      // Queued operations must resolve the current guest when they run.
      return browserManager.setAnnotationViewportBridge(
        args.browserPageId,
        {
          enabled: args.enabled,
          emitViewport: args.emitViewport,
          markers: args.markers,
          selectionId: args.selectionId,
          token: args.token
        },
        resolveGuest
      )
    }
  )

  // Publish through main's attached browser-host lease; direct renderer traffic would be refused as stale.
  ipcMain.handle(
    'browser:publishClientPageMetadata',
    async (
      event,
      args: { environmentId: string; params: unknown }
    ): Promise<BrowserClientPageMetadataPublishOutcome> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return { status: 'refused' }
      }
      if (typeof args?.environmentId !== 'string' || !args.environmentId) {
        return { status: 'refused' }
      }
      const params = BrowserClientPageMetadataParams.safeParse(args.params)
      if (!params.success) {
        return { status: 'refused' }
      }
      try {
        return {
          status: 'published',
          ...(await publishBrowserClientPageMetadata(args.environmentId, params.data))
        }
      } catch (error) {
        return { status: 'failed', errorCode: browserClientPageMetadataErrorCode(error) }
      }
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

function browserClientPageMetadataErrorCode(error: unknown): string {
  if (error instanceof RemoteRuntimeClientError) {
    return error.code
  }
  return error instanceof Error ? error.message : 'browser_client_page_metadata_failed'
}
