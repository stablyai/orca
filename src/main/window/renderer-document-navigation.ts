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
  onStarted: () => void
): void {
  // Why: did-start-loading also fires for blocked external links whose renderer document survives.
  webContents.on('did-start-navigation', (_event, url, isSameDocument, isMainFrame) => {
    if (isMainFrame && !isSameDocument && isRendererDocumentNavigation(webContents.getURL(), url)) {
      onStarted()
    }
  })
}
