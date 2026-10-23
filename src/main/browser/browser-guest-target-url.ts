import { screen } from 'electron'
import type { BrowserTargetUrlChangedEvent } from '../../shared/browser-guest-events'
import type { ResolveRenderer } from './browser-guest-renderer-target'

export function setupGuestTargetUrlForwarding(args: {
  browserTabId: string
  guest: Electron.WebContents
  resolveRenderer: ResolveRenderer
}): () => void {
  const { browserTabId, guest, resolveRenderer } = args
  const handler = (_event: Electron.Event, url: string): void => {
    // The renderer gets no pointer events over the guest; the cursor lets the bubble step aside.
    const cursor = screen.getCursorScreenPoint()
    resolveRenderer(browserTabId)?.send('browser:target-url-changed', {
      browserPageId: browserTabId,
      url,
      screenX: cursor.x,
      screenY: cursor.y
    } satisfies BrowserTargetUrlChangedEvent)
  }
  guest.on('update-target-url', handler)
  return () => {
    try {
      guest.off('update-target-url', handler)
    } catch {
      // The guest may already be destroyed.
    }
  }
}
