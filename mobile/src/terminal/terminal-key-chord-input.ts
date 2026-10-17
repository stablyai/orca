import type { TerminalKeyChord } from '../../modules/orca-terminal-key-capture/src'
import { buildTerminalShortcutKey, type TerminalShortcutModifier } from './terminal-accessory-keys'
import {
  createTerminalLiveAccessoryInput,
  type TerminalLiveAccessoryInput
} from './terminal-live-accessory-input'

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
  // Why: the builder lowercases letters and restores case only from `shift`, so Alt+Shift+B keeps its B.
  if (chord.shift || /^[A-Z]$/.test(chord.key)) {
    modifiers.push('shift')
  }
  const shortcut = buildTerminalShortcutKey({ key: chord.key, modifiers })
  if (!shortcut) {
    return null
  }
  // Why: a bare key keeps its accessory id, so forward delete follows the accessory Del rule.
  return createTerminalLiveAccessoryInput({
    id: modifiers.length === 0 ? chord.key : shortcut.label,
    bytes: shortcut.bytes
  })
}
