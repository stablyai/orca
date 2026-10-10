import type { KeyboardInputEvent } from 'electron'
import {
  MAC_SPECIAL_KEYS,
  NS_COMMAND,
  NS_CONTROL,
  NS_OPTION,
  NS_SHIFT
} from '../../shared/native-terminal-keys'

export type ForwardedNativeKey = {
  characters: string
  keyCode: number
  modifierFlags: number
  isRepeat: boolean
  // A modifier released after a forwarded chord: Orca only needs its keyup.
  isRelease?: boolean
}

// A chord the native terminal handed back to Orca, replayed into the renderer as real input.
export function toKeyboardInputEvents(key: ForwardedNativeKey): KeyboardInputEvent[] {
  const keyCode = MAC_SPECIAL_KEYS[key.keyCode] ?? key.characters.slice(0, 1).toUpperCase()
  if (!keyCode) {
    return []
  }
  const modifiers: KeyboardInputEvent['modifiers'] = []
  if (key.modifierFlags & NS_SHIFT) {
    modifiers.push('shift')
  }
  if (key.modifierFlags & NS_CONTROL) {
    modifiers.push('control')
  }
  if (key.modifierFlags & NS_OPTION) {
    modifiers.push('alt')
  }
  if (key.modifierFlags & NS_COMMAND) {
    modifiers.push('meta')
  }
  if (key.isRelease) {
    return [{ type: 'keyUp', keyCode, modifiers }]
  }
  const downModifiers: KeyboardInputEvent['modifiers'] = key.isRepeat
    ? [...modifiers, 'isautorepeat']
    : modifiers
  return [
    { type: 'keyDown', keyCode, modifiers: downModifiers },
    { type: 'keyUp', keyCode, modifiers }
  ]
}
