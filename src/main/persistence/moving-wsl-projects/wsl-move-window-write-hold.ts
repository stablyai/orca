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
// A commit request is out: its outcome, not a rewrite pass that happens to end, decides the reload.
let commitPending = false
let getWindow: () => WslMoveReloadableWindow | null = () => null

/** The app window's contents, or null when none is open. */
export function setWslMoveReloadableWindow(get: () => WslMoveReloadableWindow | null): void {
  getWindow = get
}

export function isWslMoveWindowWriteHeld(): boolean {
  return held
}

function hold(): boolean {
  const window = getWindow()
  if (!window || window.isDestroyed()) {
    return false
  }
  held = true
  return true
}

/** Before a rewrite of window-owned state: drops the open window's saves until it reloads. */
export function holdWslMoveWindowWrites(): void {
  if (hold()) {
    reloadOwed = true
  }
}

/** Before a commit request: the host may publish the moved projects to the window from here on. */
export function holdWslMoveWindowWritesForCommit(): void {
  if (hold()) {
    commitPending = true
  }
}

/** The commit request settled: committed, the window reloads; otherwise its saves resume. */
export function settleWslMoveWindowWriteHoldForCommit(committed: boolean): void {
  if (!commitPending) {
    return
  }
  commitPending = false
  if (committed) {
    reloadOwed = true
  }
  if (reloadOwed) {
    reloadWslMoveWindowWithWritesHeld()
  } else {
    held = false
  }
}

/** After the rewrite is on disk: reloads the held window. A no-op when nothing was held. */
export function reloadWslMoveWindowWithWritesHeld(onReloaded: () => void = () => {}): void {
  if (!reloadOwed || commitPending) {
    onReloaded()
    return
  }
  reloadOwed = false
  const window = getWindow()
  if (!window || window.isDestroyed()) {
    held = false
    onReloaded()
    return
  }
  // Why override: drafts reach disk with each save before the hold, and a vetoed reload would keep
  // the stale page with its saves dropped.
  const removeAllowUnload = window.allowUnload()
  const removeLift = window.onLoadedOrGone(() => {
    held = false
    removeAllowUnload()
    removeLift()
    onReloaded()
  })
  // After the caller's reply reaches the renderer, so its awaited call settles first.
  setImmediate(() => {
    if (!window.isDestroyed()) {
      window.reload()
    }
  })
}

export function resetWslMoveWindowWriteHoldForTests(): void {
  held = false
  reloadOwed = false
  commitPending = false
  getWindow = () => null
}
