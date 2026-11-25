import type { BrowserGuestDiscardProtection } from '../../../../../shared/browser/guest-lifecycle/browser-guest-discard-protection'

type IdleProtection = { audibleChangedAt: number | null; backgroundActivity: boolean }
const idleProtection = new WeakMap<Electron.WebContents, IdleProtection>()
// Orca's page visibility, not the native window's: a page shown in a minimized window stays visible.
const semanticVisibility = new WeakMap<Electron.WebContents, boolean>()
const notificationGrants = new WeakMap<Electron.Session, (pageUrl: string) => boolean>()
const RECENT_AUDIO_MS = 60_000

const semanticVisibilityListeners = new Set<(guest: Electron.WebContents) => void>()

export function setBrowserGuestSemanticVisibility(
  guest: Electron.WebContents,
  visible: boolean | null
): void {
  if (visible === null) {
    semanticVisibility.delete(guest)
  } else {
    semanticVisibility.set(guest, visible)
  }
  for (const listener of semanticVisibilityListeners) {
    listener(guest)
  }
}

export function onBrowserGuestSemanticVisibilityChanged(
  listener: (guest: Electron.WebContents) => void
): () => void {
  semanticVisibilityListeners.add(listener)
  return () => semanticVisibilityListeners.delete(listener)
}

/** Null until the owning renderer has reported this page's visibility. */
export function readBrowserGuestSemanticVisibility(guest: Electron.WebContents): boolean | null {
  return semanticVisibility.get(guest) ?? null
}

/** The partition's existing permission answers; read without prompting. */
export function registerBrowserSessionNotificationGrant(
  sess: Electron.Session,
  isGranted: (pageUrl: string) => boolean
): void {
  notificationGrants.set(sess, isGranted)
}

/** Checks live-only state at admission; proactive adds idle-only protections. */
export function readBrowserGuestIdleProtection(
  guest: Electron.WebContents,
  protection: BrowserGuestDiscardProtection,
  proactive: boolean
): BrowserGuestDiscardProtection {
  const owner = idleProtection.get(guest)
  if (protection.protection !== 'discardable' || !owner) {
    return protection
  }
  const result = (
    reason: BrowserGuestDiscardProtection['reason']
  ): BrowserGuestDiscardProtection => ({ ...protection, protection: 'protected', reason })
  let url: string
  try {
    url = guest.getURL()
    if (guest.isBeingCaptured()) {
      return result('capture')
    }
  } catch {
    return { ...protection, protection: 'unknown', reason: 'observer' }
  }
  if (
    owner.audibleChangedAt !== null &&
    performance.now() - owner.audibleChangedAt < RECENT_AUDIO_MS
  ) {
    return result('audio')
  }
  if (!proactive) {
    return protection
  }
  if (owner.backgroundActivity) {
    return result('background-activity')
  }
  // Partitions without Orca's permission handler deny notifications.
  if (notificationGrants.get(guest.session)?.(url)) {
    return result('notifications')
  }
  return protection
}

export function installBrowserGuestIdleProtection(
  guest: Electron.WebContents,
  changed: () => void
): () => void {
  const owner: IdleProtection = { audibleChangedAt: null, backgroundActivity: false }
  idleProtection.set(guest, owner)
  const audioChanged = (): void => {
    owner.audibleChangedAt = performance.now()
    changed()
  }
  // Background title and favicon changes protect the current document until the next commit,
  // ignoring load-time churn. Electron has no loaded-idle state or favicon reason, so this also
  // counts a quiet page's first update after load and media-query favicon swaps.
  let title: string | null = null
  let favicons: string | null = null
  const backgroundUpdate = (changed: boolean): void => {
    if (changed && semanticVisibility.get(guest) === false && !guest.isLoading()) {
      owner.backgroundActivity = true
    }
  }
  const titleUpdated = (_event: Electron.Event, next: string): void => {
    const changed = title !== null && next !== title
    title = next
    backgroundUpdate(changed)
  }
  const faviconUpdated = (_event: Electron.Event, next: string[]): void => {
    const key = next.join('\n')
    const changed = favicons !== null && key !== favicons
    favicons = key
    backgroundUpdate(changed)
  }
  // Keep the baselines: unchanged titles and favicons aren't re-sent after a commit.
  const committed = (): void => {
    owner.backgroundActivity = false
  }
  guest.on('audio-state-changed', audioChanged)
  guest.on('page-title-updated', titleUpdated)
  guest.on('page-favicon-updated', faviconUpdated)
  guest.on('did-navigate', committed)
  return () => {
    idleProtection.delete(guest)
    guest.off('audio-state-changed', audioChanged)
    guest.off('page-title-updated', titleUpdated)
    guest.off('page-favicon-updated', faviconUpdated)
    guest.off('did-navigate', committed)
  }
}
