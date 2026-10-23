/**
 * A window hydrated before a move's desktop rewrite (or before "Use on this computer again") holds
 * stale state, and every save it makes would write that back. So from the rewrite until the
 * window's next page has loaded, its saves (session, UI, the unload checkpoint) are dropped, and
 * main reloads it; the new page reads the rewritten state from disk. One path for move and undo.
 */

export type WslMoveReloadableWindow = {
  isDestroyed: () => boolean
  reload: () => void
  /** Lets the next unload past a beforeunload veto; returns its removal. */
  allowUnload: () => () => void
  /** Calls back once the next page has loaded or the window is gone; returns its removal. */
  onLoadedOrGone: (listener: () => void) => () => void
}

let held = false
let reloadOwed = false
let getWindow: () => WslMoveReloadableWindow | null = () => null

/** The app window's contents, or null when none is open. */
export function setWslMoveReloadableWindow(get: () => WslMoveReloadableWindow | null): void {
  getWindow = get
}

export function isWslMoveWindowWriteHeld(): boolean {
  return held
}

/** Before a rewrite of window-owned state: drops the open window's saves until it reloads. */
export function holdWslMoveWindowWrites(): void {
  const window = getWindow()
  if (window && !window.isDestroyed()) {
    held = true
    reloadOwed = true
  }
}

/** After the rewrite is on disk: reloads the held window. A no-op when nothing was held. */
export function reloadWslMoveWindowWithWritesHeld(): void {
  if (!reloadOwed) {
    return
  }
  reloadOwed = false
  const window = getWindow()
  if (!window || window.isDestroyed()) {
    held = false
    return
  }
  // Why override: drafts reach disk with each save before the hold, and a vetoed reload would keep
  // the stale page with its saves dropped.
  const removeAllowUnload = window.allowUnload()
  const removeLift = window.onLoadedOrGone(() => {
    held = false
    removeAllowUnload()
    removeLift()
  })
  // After the caller's reply reaches the renderer, so its awaited call settles first.
  setImmediate(() => {
    if (!window.isDestroyed()) {
      window.reload()
    }
  })
}

/** A move that ended short of its commit rewrote nothing: the window's saves resume, unreloaded. */
export function dropUnusedWslMoveWindowWriteHold(): void {
  if (reloadOwed) {
    reloadOwed = false
    held = false
  }
}
