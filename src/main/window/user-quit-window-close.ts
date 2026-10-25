import type { BrowserWindow } from 'electron'

/**
 * Marks a window close that a user Quit asked for on a host that stays running (`orca serve`).
 * Why separate from isQuitting: the process is not quitting, but the close still needs the quit
 * close semantics — the frozen-renderer ack deadline and no minimize-to-tray.
 */
/** Only the window's identity is used, so a narrow slice of BrowserWindow is enough. */
export type UserQuitClosingWindow = Pick<BrowserWindow, 'isDestroyed'>

const pendingUserQuitCloses = new WeakSet<UserQuitClosingWindow>()

export function markUserQuitWindowClose(window: UserQuitClosingWindow): void {
  pendingUserQuitCloses.add(window)
}

/** One close attempt consumes the mark, so a later plain close keeps its own semantics. */
export function consumeUserQuitWindowClose(window: UserQuitClosingWindow): boolean {
  return pendingUserQuitCloses.delete(window)
}
