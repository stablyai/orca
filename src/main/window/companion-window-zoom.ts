import type { BrowserWindow } from 'electron'
import {
  stepUIZoomLevel,
  type UIZoomDirection
} from '../../shared/app-lifecycle/windows/ui-zoom-level'
import type { KeybindingOverrides } from '../../shared/keybindings/types'
import {
  nativeZoomCommandMatchesKeybindings,
  resolveZoomShortcut
} from '../../shared/keybindings/window-shortcut-policy'

export function zoomCompanionWindow(window: BrowserWindow, direction: UIZoomDirection): void {
  const contents = window.webContents
  contents.setZoomLevel(stepUIZoomLevel(contents.getZoomLevel(), direction))
}

/** A popout has a single panel and owns its zoom independently of the main window. */
export function installCompanionWindowZoom(
  window: BrowserWindow,
  getKeybindings?: () => KeybindingOverrides | undefined
): void {
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') {
      return
    }
    const zoom = resolveZoomShortcut(input, process.platform, getKeybindings?.(), {
      context: 'app'
    })
    if (zoom && zoom.region !== 'sidebar') {
      event.preventDefault()
      zoomCompanionWindow(window, zoom.direction)
    }
  })
  window.webContents.on('zoom-changed', (event, direction) => {
    if (
      (direction === 'in' || direction === 'out') &&
      nativeZoomCommandMatchesKeybindings(direction, process.platform, getKeybindings?.(), {
        context: 'app'
      })
    ) {
      event.preventDefault()
      zoomCompanionWindow(window, direction)
    }
  })
}
