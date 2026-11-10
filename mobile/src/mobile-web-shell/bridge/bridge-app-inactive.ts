/**
 * Shell to page, a frame: the app is leaving the foreground. iOS sends a page `visibilitychange`
 * only once the app reaches the background, and a swipe-kill from the app switcher can stop it
 * while it is merely inactive, so the page saves what it would save on hide when this arrives.
 * Pages that read it say so in `ready`; older pages never receive one, and older shells never
 * send one, so the page keeps saving on hide alone.
 */
export const BRIDGE_APP_INACTIVE_FRAME = 'appInactive'

const listeners = new Set<() => void>()

/** Page side: runs `listener` each time the shell says the app is leaving the foreground. */
export function onPageAppInactive(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emitPageAppInactive(): void {
  for (const listener of listeners) {
    listener()
  }
}
