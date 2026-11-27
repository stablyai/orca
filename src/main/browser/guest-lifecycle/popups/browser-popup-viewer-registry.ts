const activePopupViewersByPageId = new Map<string, Map<symbol, string>>()
const activeScreencastViewerCountByGuestId = new Map<number, number>()
const hiddenPopupGuestIds = new Set<number>()

/** Ref-counted per screencast subscription so overlapping reconnects never drop an active viewer. */
export function addBrowserPopupViewer(
  browserPageId: string,
  guestWebContentsId: number,
  pairedDeviceId: string
): () => void {
  const token = Symbol('popup-viewer')
  let viewers = activePopupViewersByPageId.get(browserPageId)
  if (!viewers) {
    viewers = new Map()
    activePopupViewersByPageId.set(browserPageId, viewers)
  }
  viewers.set(token, pairedDeviceId)
  activeScreencastViewerCountByGuestId.set(
    guestWebContentsId,
    (activeScreencastViewerCountByGuestId.get(guestWebContentsId) ?? 0) + 1
  )
  let stopped = false
  return () => {
    if (stopped) {
      return
    }
    stopped = true
    const current = activePopupViewersByPageId.get(browserPageId)
    if (current) {
      current.delete(token)
      if (current.size === 0) {
        activePopupViewersByPageId.delete(browserPageId)
      }
    }
    const nextCount = (activeScreencastViewerCountByGuestId.get(guestWebContentsId) ?? 1) - 1
    if (nextCount > 0) {
      activeScreencastViewerCountByGuestId.set(guestWebContentsId, nextCount)
    } else {
      activeScreencastViewerCountByGuestId.delete(guestWebContentsId)
    }
  }
}

export function hasActiveBrowserScreencastViewer(guestWebContentsId: number): boolean {
  return (activeScreencastViewerCountByGuestId.get(guestWebContentsId) ?? 0) > 0
}

export function getActiveBrowserPopupViewer(
  browserPageId: string | null | undefined
): string | null {
  if (!browserPageId) {
    return null
  }
  const viewers = activePopupViewersByPageId.get(browserPageId)
  return viewers && viewers.size > 0 ? ([...viewers.values()].at(-1) ?? null) : null
}

export function markHiddenPopupGuest(guestWebContentsId: number): void {
  hiddenPopupGuestIds.add(guestWebContentsId)
}

export function unmarkHiddenPopupGuest(guestWebContentsId: number): void {
  hiddenPopupGuestIds.delete(guestWebContentsId)
}

export function isHiddenPopupGuest(guestWebContentsId: number): boolean {
  return hiddenPopupGuestIds.has(guestWebContentsId)
}
