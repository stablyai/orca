import type { Terminal } from '@xterm/headless'
import type { TerminalMouseModeMirror } from './terminal-mouse-mode-mirror'
import type { TerminalModes } from './types'

type TerminalWithKittyKeyboard = Terminal & {
  // Why: kitty keyboard flags aren't on the public IModes; read the core service the CSI u handlers mutate.
  _core?: { coreService?: { kittyKeyboard?: { flags?: number } } }
}

export function readKittyKeyboardFlags(terminal: Terminal): number {
  const flags = (terminal as TerminalWithKittyKeyboard)._core?.coreService?.kittyKeyboard?.flags
  return typeof flags === 'number' ? flags : 0
}

/** Mode state a snapshot must carry so a restored pane behaves like the live one. */
export function readTerminalModes(
  terminal: Terminal,
  mouseModes: TerminalMouseModeMirror
): TerminalModes {
  const buffer = terminal.buffer.active
  const mouseTrackingMode = mouseModes.mouseTrackingMode
  return {
    bracketedPaste: terminal.modes.bracketedPasteMode,
    mouseTracking: mouseTrackingMode !== 'none',
    mouseTrackingMode,
    sgrMouseMode: mouseModes.sgrMouseMode,
    sgrMousePixelsMode: mouseModes.sgrMousePixelsMode,
    applicationCursor: buffer.type === 'normal' ? terminal.modes.applicationCursorKeysMode : false,
    alternateScreen: buffer.type === 'alternate',
    kittyKeyboardFlags: readKittyKeyboardFlags(terminal)
  }
}
