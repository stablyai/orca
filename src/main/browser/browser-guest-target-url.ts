import { screen } from 'electron'
import type { BrowserTargetUrlChangedEvent } from '../../shared/browser-guest-events'
import type { ResolveRenderer } from './browser-guest-renderer-target'

const POINTER_REFRESH_MS = 100

export function setupGuestTargetUrlForwarding(args: {
  browserTabId: string
  guest: Electron.WebContents
  resolveRenderer: ResolveRenderer
}): () => void {
  const { browserTabId, guest, resolveRenderer } = args
  let targetUrl = ''
  let refreshTimer: ReturnType<typeof setTimeout> | null = null

  const send = (): void => {
    // The renderer gets no pointer events over the guest; the cursor lets the bubble step aside.
    const cursor = screen.getCursorScreenPoint()
    resolveRenderer(browserTabId)?.send('browser:target-url-changed', {
      browserPageId: browserTabId,
      url: targetUrl,
      screenX: cursor.x,
      screenY: cursor.y
    } satisfies BrowserTargetUrlChangedEvent)
  }

  // Listen to mouse moves only while a link is targeted, at most one IPC per refresh interval.
  const refreshPointer = (_event: Electron.Event, mouse: Electron.MouseInputEvent): void => {
    if (mouse.type !== 'mouseMove' || refreshTimer) {
      return
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      if (targetUrl) {
        send()
      }
    }, POINTER_REFRESH_MS)
  }

  const setTarget = (url: string): void => {
    if (url && !targetUrl) {
      guest.on('before-mouse-event', refreshPointer)
    } else if (!url && targetUrl) {
      guest.off('before-mouse-event', refreshPointer)
    }
    targetUrl = url
    send()
  }

  const handleTargetUrl = (_event: Electron.Event, url: string): void => setTarget(url)
  // A guest that dies under a hovered link never reports leaving it.
  const handleGuestGone = (): void => {
    if (targetUrl) {
      setTarget('')
    }
  }

  guest.on('update-target-url', handleTargetUrl)
  guest.on('render-process-gone', handleGuestGone)
  return () => {
    if (refreshTimer) {
      clearTimeout(refreshTimer)
    }
    try {
      // A destroyed guest unregisters here, so this is its last chance to clear the bubble.
      handleGuestGone()
      guest.off('update-target-url', handleTargetUrl)
      guest.off('render-process-gone', handleGuestGone)
      guest.off('before-mouse-event', refreshPointer)
    } catch {
      // The guest may already be destroyed.
    }
  }
}
