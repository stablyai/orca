import {
  encodeTerminalCtrlEnter,
  encodeTerminalShiftEnter,
  TERMINAL_CSI_U_CTRL_ENTER_INPUT,
  TERMINAL_KITTY_SHIFT_ENTER_INPUT
} from '../../../../src/shared/terminal/protocol/input-modes/terminal-modified-enter-encoding'
import type { TerminalModes } from '../webview/terminal-webview-contract'

// eslint-disable-next-line no-control-regex -- unmodified CSI cursor keys
const UNMODIFIED_CURSOR_KEY = /^\x1b\[([ABCDHF])$/

/** Encode a key the way desktop would for this pane's current modes and host. */
export function encodeTerminalKeyForModes(
  bytes: string,
  modes: TerminalModes | undefined,
  hostPlatform?: NodeJS.Platform
): string {
  if (bytes === TERMINAL_KITTY_SHIFT_ENTER_INPUT) {
    return encodeTerminalShiftEnter({
      canSendCsiU: (modes?.kittyKeyboardFlags ?? 0) > 0,
      modifyOtherKeys: modes?.modifyOtherKeys ?? 0
    })
  }
  if (bytes === TERMINAL_CSI_U_CTRL_ENTER_INPUT) {
    // A Windows host's pane may be ConPTY; an unknown host keeps CR, the pre-CSI-u behaviour.
    const conptyPossible = hostPlatform === undefined || hostPlatform === 'win32'
    return encodeTerminalCtrlEnter(!conptyPossible || (modes?.kittyKeyboardFlags ?? 0) > 0)
  }
  // Match xterm's legacy encoder: DECCKM sends unmodified arrows, Home and End as SS3; its Kitty encoder keeps CSI.
  const legacyApplicationCursor =
    modes?.applicationCursorKeysMode === true && modes.kittyKeyboardFlags === 0
  const cursorKey = legacyApplicationCursor ? UNMODIFIED_CURSOR_KEY.exec(bytes) : null
  return cursorKey ? `\x1bO${cursorKey[1]}` : bytes
}
