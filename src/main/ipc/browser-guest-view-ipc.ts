import { ipcMain } from 'electron'
import { browserManager } from '../browser/browser-manager'
import { publishBrowserClientPageMetadata } from '../browser/browser-client-page-metadata-transport'
import {
  BrowserClientPageMetadataParams,
  type BrowserClientPageMetadataPublishOutcome
} from '../../shared/browser-client-page-metadata-protocol'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
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
  ipcMain.removeAllListeners?.('browser:reportViewportScrollState')
  ipcMain.removeHandler('browser:setAnnotationViewportBridge')
  ipcMain.removeHandler('browser:acceptDownload')
  ipcMain.removeHandler('browser:cancelDownload')
  ipcMain.removeHandler('browser:publishClientPageMetadata')

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
        !isValidBrowserAnnotationViewportBridgeToken(args.token)
      ) {
        return false
      }
      // Why resolve here: this is a tool acting on a guest the reader is looking at, so it answers
      // for a workspace document too — and routing through the authority also pins the request to
      // the renderer that owns the target, which page-id-only resolution never checked.
      const resolveGuest = (): Electron.WebContents | null =>
        browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id)
      if (!resolveGuest()) {
        return false
      }
      // Why hand over the resolver rather than that guest: the op is serialized per tab, and the
      // one it finally runs against must be the one on screen then, not the one this request saw.
      return browserManager.setAnnotationViewportBridge(
        args.browserPageId,
        {
          enabled: args.enabled,
          emitViewport: args.emitViewport,
          markers: args.markers,
          token: args.token
        },
        resolveGuest
      )
    }
  )

  // Why this is not an ordinary runtime call: the runtime accepts page traffic only on the
  // connection its browser-host lease attached on, and that lease lives here in main. A renderer
  // publishing straight to the runtime is refused as a stale lease and the page's URL never moves.
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
