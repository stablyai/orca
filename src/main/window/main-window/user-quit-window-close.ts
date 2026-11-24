import type { BrowserWindow } from 'electron'

/** User Quit on serve closes windows while the host stays alive; retain quit acknowledgement deadlines and bypass tray minimization without setting process isQuitting. */
export type UserQuitClosingWindow = Pick<BrowserWindow, 'isDestroyed'>

const pendingUserQuitCloses = new WeakSet<UserQuitClosingWindow>()

export function markUserQuitWindowClose(window: UserQuitClosingWindow): void {
  pendingUserQuitCloses.add(window)
}

/** One close attempt consumes the mark, so a later plain close keeps its own semantics. */
export function consumeUserQuitWindowClose(window: UserQuitClosingWindow): boolean {
  return pendingUserQuitCloses.delete(window)
}
