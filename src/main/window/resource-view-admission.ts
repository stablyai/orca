import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { getRuntimeDesktopSurface } from '../runtime/runtime-desktop-surface'
import type { ResourceViewAdmission } from '../../shared/resource-view-admission'

export function isResourceWindowVisible(window: BrowserWindow | null): boolean {
  return !!window && !window.isDestroyed() && window.isVisible() && !window.isMinimized()
}

export function assertResourceViewVisible(
  event: IpcMainInvokeEvent,
  admission?: ResourceViewAdmission
): void {
  if (
    admission?.resourceManagerView &&
    !getRuntimeDesktopSurface().isResourceViewVisible?.(event.sender)
  ) {
    throw new Error('view_not_visible')
  }
}
