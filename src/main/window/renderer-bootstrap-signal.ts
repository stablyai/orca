/**
 * Fan-out for the one message a renderer sends before anything else in its entry module runs.
 *
 * Why its own file: the crash-reporting IPC layer is the only place this signal arrives, and it
 * must not pull in `@electron-toolkit/utils` (and through it `electron`) just to relay a number.
 */

/** First statement of every renderer entry module, so its arrival proves app JS ran. */
export const RENDERER_BOOTSTRAP_BREADCRUMB = 'renderer_bootstrap_started'

const bootstrapObservers = new Map<number, Set<() => void>>()

/** Subscribes to bootstrap confirmations from one renderer; returns the unsubscribe. */
export function observeRendererBootstrap(
  webContentsId: number,
  onBootstrapped: () => void
): () => void {
  const observers = bootstrapObservers.get(webContentsId) ?? new Set<() => void>()
  observers.add(onBootstrapped)
  bootstrapObservers.set(webContentsId, observers)
  return () => {
    observers.delete(onBootstrapped)
    if (observers.size === 0) {
      bootstrapObservers.delete(webContentsId)
    }
  }
}

export function notifyRendererBootstrapped(webContentsId: number): void {
  // Set iteration tolerates an observer unsubscribing itself mid-notify.
  for (const observer of bootstrapObservers.get(webContentsId) ?? []) {
    observer()
  }
}
