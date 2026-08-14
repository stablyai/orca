import type { WebContents } from 'electron'

function isRendererDocumentNavigation(currentUrl: string, nextUrl: string): boolean {
  try {
    const current = new URL(currentUrl)
    const next = new URL(nextUrl)
    if (current.protocol === 'file:') {
      return (
        next.protocol === 'file:' &&
        next.host === current.host &&
        next.pathname === current.pathname
      )
    }
    return (
      (current.protocol === 'http:' || current.protocol === 'https:') &&
      next.origin === current.origin
    )
  } catch {
    return false
  }
}

export function registerRendererDocumentNavigation(
  webContents: Pick<WebContents, 'getURL' | 'on'>,
  onStarted: () => (() => void) | void
): void {
  const pendingUrls: string[] = []
  let cancelReload: (() => void) | null = null
  const cancelPending = (url: string): void => {
    const index = pendingUrls.indexOf(url)
    if (index !== -1) {
      pendingUrls.splice(index, 1)
    }
    if (pendingUrls.length === 0) {
      const cancel = cancelReload
      cancelReload = null
      cancel?.()
    }
  }
  // Why: did-start-loading also fires for blocked external links whose renderer document survives.
  webContents.on('did-start-navigation', (_event, url, isSameDocument, isMainFrame) => {
    if (isMainFrame && !isSameDocument && isRendererDocumentNavigation(webContents.getURL(), url)) {
      if (pendingUrls.length === 0) {
        cancelReload = onStarted() ?? null
      }
      pendingUrls.push(url)
    }
  })
  webContents.on(
    'did-fail-provisional-load',
    (_event, _errorCode, _errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame) {
        return
      }
      cancelPending(validatedUrl)
    }
  )
  webContents.on('will-navigate', (event, url, _sameDocument, isMainFrame) => {
    if (!isMainFrame) {
      return
    }
    queueMicrotask(() => {
      if (event.defaultPrevented) {
        cancelPending(url)
      }
    })
  })
  webContents.on('did-frame-navigate', (_event, _url, _code, _status, isMainFrame) => {
    if (isMainFrame) {
      pendingUrls.length = 0
      cancelReload = null
    }
  })
}
