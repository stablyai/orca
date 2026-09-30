import { ipcMain } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { join } from 'node:path'
import { z } from 'zod'
import {
  OffscreenPageCommandSchema,
  OffscreenPageFileDropSchema,
  OffscreenPageSelectMenuPointSchema,
  OffscreenPageUserInputSchema,
  OffscreenPageViewportSchema
} from '../../shared/offscreen-page-protocol'
import { isBrowserRoutePartition } from '../../shared/browser-route-partition'
import {
  OFFSCREEN_PAGE_GUEST_CHANNELS,
  OFFSCREEN_PAGE_GUEST_KIND_CHANNEL
} from '../../shared/offscreen-page-guest-channels'
import { isAdmissibleBrowserPageGuest } from '../browser/browser-page-guest-admission'
import { OffscreenPageHost } from '../browser/offscreen-page-host'
import {
  clearOffscreenPageKeyboardFocus,
  setOffscreenPageKeyboardFocus
} from '../browser/offscreen-page-keyboard-routing'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'

export const offscreenPageHost = new OffscreenPageHost()

const CreateArgsSchema = z.object({
  browserPageId: z.string().min(1).max(256),
  partition: z.string().min(1).max(512),
  src: z.string().max(32 * 1024),
  viewport: OffscreenPageViewportSchema
})
const PageIdSchema = z.string().min(1).max(256)

const INVOKE_CHANNELS = [
  'offscreenPage:create',
  'offscreenPage:caret',
  OFFSCREEN_PAGE_GUEST_KIND_CHANNEL
] as const
const SEND_CHANNELS = [
  'offscreenPage:viewport',
  'offscreenPage:input',
  'offscreenPage:command',
  'offscreenPage:focus',
  'offscreenPage:keyboardFocus',
  'offscreenPage:selectMenu',
  'offscreenPage:refreshHover',
  'offscreenPage:dropFiles',
  'offscreenPage:close'
] as const

const watchedRenderers = new WeakSet<WebContents>()

export function registerOffscreenPageHandlers(): void {
  for (const channel of INVOKE_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  for (const channel of SEND_CHANNELS) {
    ipcMain.removeAllListeners(channel)
  }
  const guestPreloadPath = join(__dirname, 'browser-page-guest-preload.js')

  ipcMain.handle('offscreenPage:create', (event, rawArgs: unknown) => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return null
    }
    const args = CreateArgsSchema.safeParse(rawArgs)
    // Why fail closed: this is the offscreen twin of will-attach-webview and must refuse the same inputs.
    // Why refuse routed partitions: route registration authenticates guests by webview host.
    if (
      !args.success ||
      isBrowserRoutePartition(args.data.partition) ||
      !isAdmissibleBrowserPageGuest(args.data.partition, args.data.src)
    ) {
      return null
    }
    closePagesWithRenderer(event.sender)
    const contents = offscreenPageHost.create({
      ...args.data,
      rendererWebContentsId: event.sender.id,
      guestPreloadPath
    })
    return contents.id
  })

  // Asked by every browser page's preload; only offscreen pages install Orca's overlays.
  ipcMain.handle(OFFSCREEN_PAGE_GUEST_KIND_CHANNEL, (event) =>
    offscreenPageHost.hostsWebContents(event.sender.id) ? OFFSCREEN_PAGE_GUEST_CHANNELS : null
  )

  ipcMain.handle('offscreenPage:caret', (event, rawPageId: unknown) => {
    const pageId = ownedPageId(event, rawPageId)
    return pageId ? offscreenPageHost.readCaret(pageId) : null
  })

  onOwnedPage('offscreenPage:viewport', (pageId, payload) => {
    const viewport = OffscreenPageViewportSchema.safeParse(payload)
    if (viewport.success) {
      offscreenPageHost.setViewport(pageId, viewport.data)
    }
  })
  onOwnedPage('offscreenPage:input', (pageId, payload) => {
    const input = OffscreenPageUserInputSchema.safeParse(payload)
    if (input.success) {
      void offscreenPageHost.dispatchUserInput(pageId, input.data).catch(() => {})
    }
  })
  onOwnedPage('offscreenPage:command', (pageId, payload) => {
    const command = OffscreenPageCommandSchema.safeParse(payload)
    if (command.success) {
      offscreenPageHost.runCommand(pageId, command.data)
    }
  })
  onOwnedPage('offscreenPage:focus', (pageId) => offscreenPageHost.focusPage(pageId))
  ipcMain.on('offscreenPage:keyboardFocus', (event, rawPageId: unknown, focused: unknown) => {
    const pageId = ownedPageId(event, rawPageId)
    if (pageId && typeof focused === 'boolean') {
      setOffscreenPageKeyboardFocus(event.sender.id, pageId, focused)
      offscreenPageHost.setKeyboardFocus(pageId, focused)
    }
  })
  onOwnedPage('offscreenPage:dropFiles', (pageId, payload) => {
    const drop = OffscreenPageFileDropSchema.safeParse(payload)
    if (drop.success) {
      offscreenPageHost.dropFiles(pageId, drop.data)
    }
  })
  onOwnedPage('offscreenPage:selectMenu', (pageId, payload) => {
    const point = OffscreenPageSelectMenuPointSchema.safeParse(payload)
    if (point.success) {
      offscreenPageHost.showSelectMenu(pageId, point.data)
    }
  })
  ipcMain.on('offscreenPage:refreshHover', (event, rawPageId: unknown, payload: unknown) => {
    const point = OffscreenPageSelectMenuPointSchema.safeParse(payload)
    if (ownedPageId(event, rawPageId) && point.success) {
      // Why: a real move re-runs Chromium's hover tooltip lookup; the page sees a zero-length move.
      const zoom = event.sender.getZoomFactor()
      event.sender.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(point.data.x * zoom),
        y: Math.round(point.data.y * zoom)
      })
    }
  })
  onOwnedPage('offscreenPage:close', (pageId) => offscreenPageHost.close(pageId))
}

function ownedPageId(event: IpcMainEvent | IpcMainInvokeEvent, rawPageId: unknown): string | null {
  const pageId = PageIdSchema.safeParse(rawPageId)
  if (!pageId.success || !isTrustedBrowserRenderer(event.sender)) {
    return null
  }
  return offscreenPageHost.isOwnedBy(pageId.data, event.sender.id) ? pageId.data : null
}

function onOwnedPage(
  channel: (typeof SEND_CHANNELS)[number],
  handle: (pageId: string, payload: unknown) => void
): void {
  ipcMain.on(channel, (event, rawPageId: unknown, payload: unknown) => {
    const pageId = ownedPageId(event, rawPageId)
    if (pageId) {
      handle(pageId, payload)
    }
  })
}

/** Pages die with the renderer document that shows them, exactly as <webview> guests do. */
function closePagesWithRenderer(renderer: WebContents): void {
  if (watchedRenderers.has(renderer)) {
    return
  }
  watchedRenderers.add(renderer)
  const closeOwned = () => {
    clearOffscreenPageKeyboardFocus(renderer.id)
    offscreenPageHost.closeOwnedBy(renderer.id)
  }
  renderer.once('destroyed', closeOwned)
  // Why: a <webview> guest dies with its embedder's process, and a reload re-creates pages anyway.
  renderer.on('render-process-gone', closeOwned)
  renderer.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      closeOwned()
    }
  })
}
