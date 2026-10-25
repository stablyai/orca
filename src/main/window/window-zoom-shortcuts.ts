import type { WebContents } from 'electron'
import { stepUIZoomLevel, type UIZoomDirection } from '../../shared/ui-zoom-level'
import { nativeZoomCommandMatchesKeybindings } from '../../shared/window-shortcut-policy'
import {
  keybindingMatchesAction,
  type KeybindingActionId,
  type KeybindingInput,
  type KeybindingOverrides
} from '../../shared/keybindings'

const ZOOM_SHORTCUTS: readonly [KeybindingActionId, UIZoomDirection][] = [
  ['zoom.in', 'in'],
  ['zoom.out', 'out'],
  ['zoom.reset', 'reset']
]

export function stepWebContentsZoom(webContents: WebContents, direction: UIZoomDirection): void {
  webContents.setZoomLevel(stepUIZoomLevel(webContents.getZoomLevel(), direction))
}

function resolveZoomShortcut(
  input: KeybindingInput,
  keybindings: KeybindingOverrides | undefined
): UIZoomDirection | null {
  // Why: this runs on every keydown; avoid scanning unrelated window shortcuts in the typing path.
  for (const [actionId, direction] of ZOOM_SHORTCUTS) {
    if (
      keybindingMatchesAction(actionId, input, process.platform, keybindings, { context: 'app' })
    ) {
      return direction
    }
  }
  return null
}

/**
 * Window-local zoom for secondary windows that have no Orca renderer shortcut plumbing: only the
 * zoom chords are resolved here and every other key falls through untouched.
 */
export function installWindowLocalZoomShortcuts(
  webContents: WebContents,
  getKeybindings: () => KeybindingOverrides | undefined
): void {
  webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') {
      return
    }
    const direction = resolveZoomShortcut(input, getKeybindings())
    if (direction) {
      event.preventDefault()
      stepWebContentsZoom(webContents, direction)
    }
  })

  webContents.on('zoom-changed', (event, direction) => {
    // Why: Electron reports Ctrl/Cmd+wheel zoom outside the keyboard input path.
    if (
      (direction === 'in' || direction === 'out') &&
      nativeZoomCommandMatchesKeybindings(direction, process.platform, getKeybindings(), {
        context: 'app'
      })
    ) {
      event.preventDefault()
      stepWebContentsZoom(webContents, direction)
    }
  })
}
