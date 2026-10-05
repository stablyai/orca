import { z } from 'zod'
import {
  BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX,
  isValidBrowserAnnotationViewportBridgeToken
} from '../../shared/browser-annotation-viewport-bridge'
import type { DesktopBrowserViewEvent } from '../../shared/desktop-browser-view-protocol'
import type { DesktopOwnedBrowserViewRecord } from './desktop-owned-browser-view-admission'

const scroll = z.object({ scrollX: z.number().finite(), scrollY: z.number().finite() }).strict()

export function observeDesktopBrowserViewDocument(
  record: DesktopOwnedBrowserViewRecord,
  publish: (event: DesktopBrowserViewEvent) => void
): () => void {
  const guest = record.webContents
  const identity = { browserPageId: record.browserPageId, generation: record.generation }
  const ready = (): void => publish({ ...identity, kind: 'page-ready' })
  const start = (
    event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>
  ): void => {
    if (event.isMainFrame) {
      publish({
        ...identity,
        kind: 'navigation-start',
        url: event.url,
        sameDocument: event.isSameDocument
      })
    }
  }
  const commit = (_event: Electron.Event, url: string): void => {
    publish({ ...identity, kind: 'navigation-commit', url, sameDocument: false })
  }
  const inPage = (_event: Electron.Event, url: string, mainFrame: boolean): void => {
    if (mainFrame) {
      publish({ ...identity, kind: 'navigation-commit', url, sameDocument: true })
    }
  }
  const gone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails): void => {
    publish({ ...identity, kind: 'renderer-gone', reason: details.reason })
  }
  const consoleMessage = (
    event: Electron.Event<Electron.WebContentsConsoleMessageEventParams>
  ): void => {
    const message = event.message
    if (message.length > 1024 || !message.startsWith(BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX)) {
      return
    }
    const payload = message.slice(BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX.length)
    const delimiter = payload.indexOf(':')
    const token = payload.slice(0, delimiter)
    if (delimiter === -1 || !isValidBrowserAnnotationViewportBridgeToken(token)) {
      return
    }
    try {
      const parsed = scroll.safeParse(JSON.parse(payload.slice(delimiter + 1)))
      if (parsed.success) {
        publish({ ...identity, kind: 'annotation-viewport', token, ...parsed.data })
      }
    } catch {
      // The guest can log unrelated or malformed console messages.
    }
  }
  guest.on('dom-ready', ready)
  guest.on('did-start-navigation', start)
  guest.on('did-navigate', commit)
  guest.on('did-navigate-in-page', inPage)
  guest.on('render-process-gone', gone)
  guest.on('console-message', consoleMessage)
  return () => {
    guest.removeListener('dom-ready', ready)
    guest.removeListener('did-start-navigation', start)
    guest.removeListener('did-navigate', commit)
    guest.removeListener('did-navigate-in-page', inPage)
    guest.removeListener('render-process-gone', gone)
    guest.removeListener('console-message', consoleMessage)
  }
}
