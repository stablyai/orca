import type { Terminal } from '@xterm/headless'
import { readTerminalMouseEncoding } from '../../shared/terminal-mouse-encoding'
import type { TerminalModes } from './types'

type TerminalWithKittyKeyboard = Terminal & {
  // Kitty flags are absent from public IModes; read the service updated by CSI u.
  _core?: { coreService?: { kittyKeyboard?: { flags?: number } } }
}

export function readKittyKeyboardFlags(terminal: Terminal): number {
  const flags = (terminal as TerminalWithKittyKeyboard)._core?.coreService?.kittyKeyboard?.flags
  return typeof flags === 'number' ? flags : 0
}

// xterm lacks XTMODKEYS state; retain explicit zero after disarm to correct clients that missed it.
const modifyOtherKeysByTerminal = new WeakMap<Terminal, { level: number; armed: boolean }>()

export function trackModifyOtherKeys(terminal: Terminal): void {
  const state = { level: 0, armed: false }
  modifyOtherKeysByTerminal.set(terminal, state)
  // Return false to preserve xterm handlers, including RIS.
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
