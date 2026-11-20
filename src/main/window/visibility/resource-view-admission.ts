import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { ResourceViewAdmission } from '../../../shared/diagnostics/resource-view-admission'

export function isResourceWindowVisible(window: BrowserWindow | null): boolean {
  return !!window && !window.isDestroyed() && window.isVisible() && !window.isMinimized()
}

export function assertResourceViewVisible(
  event: IpcMainInvokeEvent,
  admission?: ResourceViewAdmission
): void {
  if (
    admission?.resourceManagerView &&
    !isResourceWindowVisible(BrowserWindow.fromWebContents(event.sender))
  ) {
    throw new Error('view_not_visible')
  }
}
