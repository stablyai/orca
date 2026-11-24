import { describe, expect, it } from 'vitest'
import { encodeTerminalKeyForModes } from './terminal-key-mode-encoding'
import { createTerminalKeyChordInput } from './terminal-key-chord-input'
import type { TerminalModes } from '../webview/terminal-webview-contract'

const MODES: TerminalModes = {
  bracketedPasteMode: false,
  altScreen: false,
  mouseTrackingMode: 'none',
  sgrMouseMode: false,
  sgrMousePixelsMode: false,
  applicationCursorKeysMode: false,
  kittyKeyboardFlags: 0,
  modifyOtherKeys: 0
}

describe('encodeTerminalKeyForModes', () => {
  it('sends unmodified cursor keys as SS3 while DECCKM is set', () => {
    const decckm = { ...MODES, applicationCursorKeysMode: true }
    expect(encodeTerminalKeyForModes('\x1b[A', decckm)).toBe('\x1bOA')
    expect(encodeTerminalKeyForModes('\x1b[H', decckm)).toBe('\x1bOH')
    expect(encodeTerminalKeyForModes('\x1b[1;5A', decckm)).toBe('\x1b[1;5A')
    expect(encodeTerminalKeyForModes('\x1b[A', MODES)).toBe('\x1b[A')
    expect(encodeTerminalKeyForModes('\x1b[A', { ...decckm, kittyKeyboardFlags: 1 })).toBe('\x1b[A')
  })

  it('sends Ctrl+Enter as CSI-u unless the pane may be an unnegotiated ConPTY', () => {
    const ctrlEnter = createTerminalKeyChordInput({
      key: 'enter',
      ctrl: true,
      alt: false,
      shift: false
    })!.bytes
    expect(encodeTerminalKeyForModes(ctrlEnter, MODES, 'linux')).toBe('\x1b[13;5u')
    expect(encodeTerminalKeyForModes(ctrlEnter, MODES, 'win32')).toBe('\r')
    expect(encodeTerminalKeyForModes(ctrlEnter, MODES, undefined)).toBe('\r')
    expect(encodeTerminalKeyForModes(ctrlEnter, { ...MODES, kittyKeyboardFlags: 1 }, 'win32')).toBe(
      '\x1b[13;5u'
    )
  })
})
