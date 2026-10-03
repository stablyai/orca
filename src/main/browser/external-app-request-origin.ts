import { safeOrigin } from './browser-manager-types'

export const UNKNOWN_EXTERNAL_APP_REQUEST_ORIGIN = 'unknown'

export type ExternalAppInitiatingFrame = {
  url?: string
  isDestroyed?: () => boolean
}

/**
 * Trusted source origin for a custom-scheme prompt.
 * Why: destination `frame` and `guest.getURL()` are the top page; an iframe
 * initiator can differ. If the actual source is missing, say unknown.
 */
export function originFromInitiatingFrame(
  frame: ExternalAppInitiatingFrame | null | undefined
): string {
  if (!frame) {
    return UNKNOWN_EXTERNAL_APP_REQUEST_ORIGIN
  }
  try {
    if (frame.isDestroyed?.()) {
      return UNKNOWN_EXTERNAL_APP_REQUEST_ORIGIN
    }
    const rawUrl = frame.url
    if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
      return UNKNOWN_EXTERNAL_APP_REQUEST_ORIGIN
    }
    const origin = safeOrigin(rawUrl)
    return origin.length > 0 ? origin : UNKNOWN_EXTERNAL_APP_REQUEST_ORIGIN
  } catch {
    return UNKNOWN_EXTERNAL_APP_REQUEST_ORIGIN
  }
}

export function originFromNavigationEvent(event: {
  initiator?: ExternalAppInitiatingFrame | null
}): string {
  return originFromInitiatingFrame(event.initiator)
}

/** Main-document origin only when a private top-frame click token already identified that document. */
export function originFromGuestDocument(guest: {
  isDestroyed?: () => boolean
  getURL?: () => string
  mainFrame?: ExternalAppInitiatingFrame | null
}): string {
  try {
    if (guest.isDestroyed?.()) {
      return UNKNOWN_EXTERNAL_APP_REQUEST_ORIGIN
    }
    if (guest.mainFrame) {
      return originFromInitiatingFrame(guest.mainFrame)
    }
    const url = guest.getURL?.()
    if (typeof url === 'string' && url.length > 0) {
      return originFromInitiatingFrame({ url })
    }
  } catch {
    // source unreadable
  }
  return UNKNOWN_EXTERNAL_APP_REQUEST_ORIGIN
}
