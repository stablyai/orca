import type { BrowserWindow } from 'electron'
import {
  stepUIZoomLevel,
  type UIZoomDirection
} from '../../shared/app-lifecycle/windows/ui-zoom-level'
import {
  ModifierDoubleTapDetector,
  toModifierDoubleTapEvent
} from '../../shared/keybindings/modifier-double-tap-detector'
import { textInputOwnsComposition } from '../../shared/keybindings/text-input-shortcut-policy'
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
  const doubleTap = new ModifierDoubleTapDetector()
  window.on('blur', () => doubleTap.reset())
  window.webContents.on('before-input-event', (event, input) => {
    if (textInputOwnsComposition(input)) {
      doubleTap.reset()
      return
    }
    if (input.type !== 'keyDown' && input.type !== 'keyUp') {
      return
    }
    const detected = doubleTap.process(
      toModifierDoubleTapEvent({ ...input, type: input.type }),
      Date.now()
    )
    if (input.type === 'keyUp') {
      return
    }
    const shortcut = detected ? { doubleTapModifier: detected.modifier } : input
    const zoom = resolveZoomShortcut(shortcut, process.platform, getKeybindings?.(), {
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
