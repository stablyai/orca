import type { BrowserWindow, Event as ElectronEvent } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import {
  WORKSPACE_POPOUT_MIN_HEIGHT,
  WORKSPACE_POPOUT_MIN_WIDTH
} from '../../../shared/workspace-popout/workspace-popout-contract'

export function attachWorkspacePopoutBoundsPersistence(
  window: BrowserWindow,
  store: Store | null
): { freezeBounds: (event?: ElectronEvent) => void; cleanup: () => void } {
  let boundsTimer: ReturnType<typeof setTimeout> | null = null
  let windowClosing = false

  const saveBounds = (): void => {
    if (boundsTimer) {
      clearTimeout(boundsTimer)
    }
    boundsTimer = setTimeout(() => {
      boundsTimer = null
      if (windowClosing || window.isDestroyed() || window.isMinimized() || window.isFullScreen()) {
        return
      }
      const b = window.getBounds()
      if (b.width >= WORKSPACE_POPOUT_MIN_WIDTH && b.height >= WORKSPACE_POPOUT_MIN_HEIGHT) {
        store?.updateUI({ workspacePopoutBounds: b })
      }
    }, 500)
  }

  const freezeBounds = (event?: ElectronEvent): void => {
    if (event?.defaultPrevented) {
      return
    }
    windowClosing = true
    if (boundsTimer) {
      clearTimeout(boundsTimer)
      boundsTimer = null
    }
  }

  window.on('resize', saveBounds)
  window.on('move', saveBounds)
  window.on('close', freezeBounds)

  return {
    freezeBounds,
    cleanup: () => {
      freezeBounds()
      window.removeListener('resize', saveBounds)
      window.removeListener('move', saveBounds)
      window.removeListener('close', freezeBounds)
    }
  }
}
