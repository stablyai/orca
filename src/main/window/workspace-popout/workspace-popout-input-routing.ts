import type { BrowserWindow, Input } from 'electron'
import type {
  KeybindingActionId,
  KeybindingOverrides,
  KeybindingInput
} from '../../../shared/keybindings/types'
import { keybindingMatchesAction } from '../../../shared/keybindings/matching'
import { nativeZoomCommandMatchesKeybindings } from '../../../shared/window-shortcut-policy'
import { stepUIZoomLevel, type UIZoomDirection } from '../../../shared/ui-zoom-level'

const ZOOM_SHORTCUTS: readonly [KeybindingActionId, UIZoomDirection][] = [
  ['zoom.in', 'in'],
  ['zoom.out', 'out'],
  ['zoom.reset', 'reset']
]

function resolveZoomShortcut(
  input: KeybindingInput,
  keybindings: KeybindingOverrides | undefined
): UIZoomDirection | null {
  for (const [actionId, direction] of ZOOM_SHORTCUTS) {
    if (
      keybindingMatchesAction(actionId, input, process.platform, keybindings, { context: 'app' })
    ) {
      return direction
    }
  }
  return null
}

export function isMacAppPasteInput(input: Input): boolean {
  if (process.platform !== 'darwin' || input.type !== 'keyDown') {
    return false
  }
  return input.meta && !input.control && !input.alt && (input.key === 'v' || input.key === 'V')
}

export function zoomWorkspacePopout(window: BrowserWindow, direction: UIZoomDirection): void {
  const webContents = window.webContents
  webContents.setZoomLevel(stepUIZoomLevel(webContents.getZoomLevel(), direction))
}

export function setupWorkspacePopoutInputRouting(
  window: BrowserWindow,
  options: {
    getKeybindings?: () => KeybindingOverrides | undefined
    onDock: () => void
  }
): void {
  window.webContents.on('before-input-event', (event, input) => {
    if (isMacAppPasteInput(input)) {
      event.preventDefault()
      window.webContents.send('ui:appMenuPaste')
      return
    }
    if (input.type !== 'keyDown') {
      return
    }
    if (keybindingMatchesAction('tab.close', input, process.platform, options.getKeybindings?.())) {
      event.preventDefault()
      options.onDock()
      return
    }
    const direction = resolveZoomShortcut(input, options.getKeybindings?.())
    if (direction) {
      event.preventDefault()
      zoomWorkspacePopout(window, direction)
    }
  })

  window.webContents.on('zoom-changed', (event, direction) => {
    if (
      (direction === 'in' || direction === 'out') &&
      nativeZoomCommandMatchesKeybindings(direction, process.platform, options.getKeybindings?.(), {
        context: 'app'
      })
    ) {
      event.preventDefault()
      zoomWorkspacePopout(window, direction)
    }
  })
}
