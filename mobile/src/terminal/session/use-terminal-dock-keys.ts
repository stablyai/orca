import { useRef, useState, type RefObject } from 'react'
import type { TextInput } from 'react-native'
import type { TerminalShortcutModifier } from '../terminal-accessory-keys'
import { createTerminalKeyChordInput } from '../terminal-key-chord-input'
import type { TerminalLiveAccessoryInput } from '../terminal-live-accessory-input'
import { writeTerminalLiveInputText } from '../terminal-live-input-text-write'
import {
  appendedCharacter,
  consumeStickyModifiers,
  hasStickyModifier,
  NO_STICKY_MODIFIERS,
  STICKY_MODIFIER_DOUBLE_TAP_MS,
  tapStickyModifier,
  type StickyModifiers
} from '../terminal-sticky-modifiers'

type UseTerminalDockKeysOptions = {
  readonly activeHandle: string | null
  readonly sendInput: (input: TerminalLiveAccessoryInput) => Promise<unknown>
}

// Key-row presses and sticky ctrl/alt/shift; held modifiers apply to the next key or typed letter.
export function useTerminalDockKeys({ activeHandle, sendInput }: UseTerminalDockKeysOptions) {
  const [modifiers, setModifiers] = useState(NO_STICKY_MODIFIERS)
  const [modifierHandle, setModifierHandle] = useState(activeHandle)
  const lastTapRef = useRef<{ modifier: TerminalShortcutModifier; at: number } | null>(null)
  // A held modifier belongs to the tab it was pressed on.
  if (modifierHandle !== activeHandle) {
    setModifierHandle(activeHandle)
    setModifiers(NO_STICKY_MODIFIERS)
  }

  const tapModifier = (modifier: TerminalShortcutModifier): void => {
    const now = Date.now()
    const last = lastTapRef.current
    const doubleTap =
      last?.modifier === modifier &&
      now - last.at < STICKY_MODIFIER_DOUBLE_TAP_MS &&
      modifiers[modifier] === 'once'
    lastTapRef.current = { modifier, at: now }
    setModifiers(tapStickyModifier(modifiers, modifier, doubleTap))
  }

  /** The held modifiers, released for the next key unless locked. */
  const takeModifiers = (): StickyModifiers => {
    if (hasStickyModifier(modifiers)) {
      setModifiers(consumeStickyModifiers(modifiers))
    }
    return modifiers
  }

  /** A row key with the held modifiers, or null when none is held or the key takes no modifier. */
  const chordInput = (key: string): TerminalLiveAccessoryInput | null =>
    hasStickyModifier(modifiers) ? terminalDockKeyInput(key, modifiers) : null

  /** Sends a special key id (`arrowUp`, `tab`, `f5`…) or a printable character with the held modifiers. */
  const sendKey = (key: string): void => {
    const input = terminalDockKeyInput(key, takeModifiers())
    if (input) {
      void sendInput(input)
    }
  }

  // With a modifier held, the next typed letter becomes a combo instead of text.
  const interceptTypedCharacter = (
    previous: string,
    next: string,
    field: RefObject<TextInput | null>
  ): boolean => {
    if (!hasStickyModifier(modifiers)) {
      return false
    }
    const typed = appendedCharacter(previous, next)
    if (typed === null) {
      return false
    }
    writeTerminalLiveInputText(field, previous)
    sendKey(typed)
    return true
  }

  return { modifiers, tapModifier, takeModifiers, chordInput, sendKey, interceptTypedCharacter }
}

function terminalDockKeyInput(
  key: string,
  modifiers: StickyModifiers
): TerminalLiveAccessoryInput | null {
  return createTerminalKeyChordInput({
    key,
    ctrl: modifiers.ctrl !== 'off',
    alt: modifiers.alt !== 'off',
    shift: modifiers.shift !== 'off'
  })
}
