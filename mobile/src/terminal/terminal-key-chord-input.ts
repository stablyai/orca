import { buildTerminalShortcutKey, type TerminalShortcutModifier } from './terminal-accessory-keys'
import {
  createTerminalLiveAccessoryInput,
  type TerminalLiveAccessoryInput
} from './terminal-live-accessory-input'

export type TerminalKeyChord = {
  readonly key: string
  readonly ctrl: boolean
  readonly alt: boolean
  readonly shift: boolean
}

export function createTerminalKeyChordInput(
  chord: TerminalKeyChord
): TerminalLiveAccessoryInput | null {
  const modifiers: TerminalShortcutModifier[] = []
  if (chord.ctrl) {
    modifiers.push('ctrl')
  }
  if (chord.alt) {
    modifiers.push('alt')
  }
  // Carry shift because the builder lowercases letters before restoring case.
  if (chord.shift || /^[A-Z]$/.test(chord.key)) {
    modifiers.push('shift')
  }
  const shortcut = buildTerminalShortcutKey({ key: chord.key, modifiers })
  if (!shortcut) {
    return null
  }
  // Keep accessory ids for unmodified keys so Del retains its forward-delete rule.
  return createTerminalLiveAccessoryInput({
    id: modifiers.length === 0 ? chord.key : shortcut.label,
    bytes: shortcut.bytes
  })
}
