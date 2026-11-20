import { webContents } from 'electron'
import { getBrowserPageIdleDiscard } from '../browser/guest-lifecycle/browser-page-idle-discard'
import { browserManager } from '../browser/guest-lifecycle/manager/browser-manager'
import { readBrowserGuestDiscardAdmission } from '../browser/guest-lifecycle/manager/registration/browser-guest-discard-protection'

/** Mirrors the discard IPC's admission, so the notice never counts a tab Memory Saver would keep. */
function canMemorySaverFree(pageId: string): boolean {
  if (browserManager.isGuestMemoryProtected(pageId)) {
    return false
  }
  const guestId = browserManager.getGuestWebContentsId(pageId)
  const guest = guestId === null ? undefined : webContents.fromId(guestId)
  return !!guest && readBrowserGuestDiscardAdmission(guest, true).protection === 'discardable'
}

/** Asked only when the hidden-tabs notice could show, so idle reads never touch browser state. */
export function countHiddenBrowserPages(hiddenForMs: number): number {
  return Number.isFinite(hiddenForMs) && hiddenForMs > 0
    ? getBrowserPageIdleDiscard().countHiddenLoadedPages(hiddenForMs, canMemorySaverFree)
    : 0
}
