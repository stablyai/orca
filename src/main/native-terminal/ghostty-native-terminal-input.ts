import type { BrowserWindow, WebContents } from 'electron'
import type { NativeTerminalForwardedChord } from '../../shared/native-terminal-forwarded-chords'
import type { NativeTerminalEvent } from '../../shared/native-terminal-ipc'
import { toKeyboardInputEvents } from './ghostty-forwarded-key'
import type { GhosttyTerminalAddon } from './ghostty-native-terminal-addon'
import { relayNativeDoubleTapInput } from './ghostty-native-terminal-double-tap'

let appliedChords: NativeTerminalForwardedChord[] = []

export function appliedForwardedChords(): NativeTerminalForwardedChord[] {
  return appliedChords
}

// Keybindings are app-wide, so the latest set from a window hosting surfaces stands for all.
export function applyForwardedChords(
  addon: GhosttyTerminalAddon,
  chords: NativeTerminalForwardedChord[]
): void {
  appliedChords = chords
  addon.setForwardedChords(
    chords.map((chord) => [chord.keyCode, chord.modifierFlags, chord.character])
  )
}

type InputEventOwner = { webContents: WebContents; window: BrowserWindow }

// Input a native surface hands back to Orca: replayed chords, pointer entry, double taps and
// Services text. False for any other addon event kind.
export function routeNativeInputEvent(
  owner: InputEventOwner,
  surfaceId: number,
  kind: string,
  args: unknown[],
  send: (event: NativeTerminalEvent) => void
): boolean {
  switch (kind) {
    case 'key':
      for (const input of toKeyboardInputEvents({
        characters: String(args[0] ?? ''),
        keyCode: Number(args[1]),
        modifierFlags: Number(args[2]),
        isRepeat: args[3] === true,
        isRelease: args[4] === true
      })) {
        owner.webContents.sendInputEvent(input)
      }
      return true
    case 'doubleTapInput':
      for (const input of relayNativeDoubleTapInput(owner.window, args)) {
        owner.webContents.sendInputEvent(input)
      }
      return true
    case 'mouseEnter':
      send({
        surfaceId,
        kind: 'mouseEnter',
        buttons: Number(args[0]),
        windowFocused: args[1] === true
      })
      return true
    case 'servicePaste':
      send({ surfaceId, kind: 'pasteText', text: String(args[0] ?? '') })
      return true
    default:
      return false
  }
}
