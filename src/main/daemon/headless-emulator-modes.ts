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

// Why a side table: xterm.js has no XTMODKEYS, so without it a snapshot drops pi's fallback
// request and a reattached pane goes back to the ambiguous `ESC CR` Shift+Enter (STA-7701).
// `armed` once ever nonzero: from then on the snapshot states the level, 0 included, so a client
// that missed the disarm is corrected while panes that never used it keep identical snapshots.
const modifyOtherKeysByTerminal = new WeakMap<Terminal, { level: number; armed: boolean }>()

/** Tracks the xterm modifyOtherKeys level (`CSI > 4 ; n m`) for readTerminalModes. */
export function trackModifyOtherKeys(terminal: Terminal): void {
  const state = { level: 0, armed: false }
  modifyOtherKeysByTerminal.set(terminal, state)
  // Return false so xterm's own handlers (none for XTMODKEYS; RIS for ESC c) still run.
  terminal.parser.registerCsiHandler({ prefix: '>', final: 'm' }, (params) => {
    if (params[0] === 4) {
      const value = params[1]
      state.level = typeof value === 'number' ? value : 0
      state.armed ||= state.level > 0
    }
    return false
  })
  terminal.parser.registerEscHandler({ final: 'c' }, () => {
    state.level = 0
    return false
  })
}

/** Mode state a snapshot must carry so a restored pane behaves like the live one. */
export function readTerminalModes(terminal: Terminal): TerminalModes {
  const buffer = terminal.buffer.active
  const mouseTrackingMode = terminal.modes.mouseTrackingMode
  const mouseEncoding = readTerminalMouseEncoding(terminal)
  const modifyOtherKeys = modifyOtherKeysByTerminal.get(terminal)
  return {
    bracketedPaste: terminal.modes.bracketedPasteMode,
    mouseTracking: mouseTrackingMode !== 'none',
    mouseTrackingMode,
    sgrMouseMode: mouseEncoding === 'sgr',
    sgrMousePixelsMode: mouseEncoding === 'sgr-pixels',
    applicationCursor: buffer.type === 'normal' ? terminal.modes.applicationCursorKeysMode : false,
    alternateScreen: buffer.type === 'alternate',
    kittyKeyboardFlags: readKittyKeyboardFlags(terminal),
    ...(modifyOtherKeys?.armed ? { modifyOtherKeys: modifyOtherKeys.level } : {})
  }
}
