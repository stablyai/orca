import { randomUUID } from 'node:crypto'
import {
  BROWSER_AUTOMATION_ACTIVITY_CHANNEL,
  BROWSER_AUTOMATION_ACTIVITY_LEASE_MS,
  BROWSER_AUTOMATION_ACTIVITY_RENEW_MS,
  type BrowserAutomationActivityEvent
} from '../../shared/browser-automation-activity'

type ActivityEndpoint = {
  isDestroyed(): boolean
  once(event: 'destroyed', listener: () => void): unknown
  removeListener(event: 'destroyed', listener: () => void): unknown
}
type ActivityRenderer = ActivityEndpoint & {
  send(channel: string, event: BrowserAutomationActivityEvent): void
}

export function holdBrowserAutomationActivity(
  browserPageId: string,
  guest: ActivityEndpoint,
  renderer: ActivityRenderer,
  isCurrentOwner: () => boolean
): () => void {
  const token = randomUUID()
  let released = false
  let renewal: ReturnType<typeof setTimeout> | null = null

  const publish = (active: boolean): boolean => {
    try {
      if (renderer.isDestroyed()) {
        return false
      }
      const event: BrowserAutomationActivityEvent = {
        browserPageId,
        token,
        active,
        expiresAt: Date.now() + (active ? BROWSER_AUTOMATION_ACTIVITY_LEASE_MS : 0)
      }
      renderer.send(BROWSER_AUTOMATION_ACTIVITY_CHANNEL, event)
      return true
    } catch {
      return false
    }
  }

  const release = (): void => {
    if (released) {
      return
    }
    released = true
    if (renewal) {
      clearTimeout(renewal)
      renewal = null
    }
    for (const endpoint of [guest, renderer]) {
      try {
        endpoint.removeListener('destroyed', release)
      } catch {
        // Why: teardown can race a disappearing WebContents wrapper.
      }
    }
    publish(false)
  }

  const renew = (): void => {
    if (released) {
      return
    }
    try {
      if (guest.isDestroyed() || !isCurrentOwner() || !publish(true)) {
        release()
        return
      }
      renewal = setTimeout(renew, BROWSER_AUTOMATION_ACTIVITY_RENEW_MS)
      renewal.unref()
    } catch {
      release()
    }
  }

  try {
    guest.once('destroyed', release)
    renderer.once('destroyed', release)
    renew()
  } catch {
    release()
  }
  return release
}
