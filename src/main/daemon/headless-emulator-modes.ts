import type { Terminal } from '@xterm/headless'
import { readTerminalMouseEncoding } from '../../shared/terminal-mouse-encoding'
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
export function readTerminalModes(terminal: Terminal): TerminalModes {
  const buffer = terminal.buffer.active
  const mouseTrackingMode = terminal.modes.mouseTrackingMode
  const mouseEncoding = readTerminalMouseEncoding(terminal)
  return {
    bracketedPaste: terminal.modes.bracketedPasteMode,
    mouseTracking: mouseTrackingMode !== 'none',
    mouseTrackingMode,
    sgrMouseMode: mouseEncoding === 'sgr',
    sgrMousePixelsMode: mouseEncoding === 'sgr-pixels',
    applicationCursor: buffer.type === 'normal' ? terminal.modes.applicationCursorKeysMode : false,
    alternateScreen: buffer.type === 'alternate',
    kittyKeyboardFlags: readKittyKeyboardFlags(terminal)
  }
}
