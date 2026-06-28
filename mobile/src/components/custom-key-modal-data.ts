// Why: extracted from CustomKeyModal.tsx so the modal file stays under the
// project max-lines budget. Static data only — no React/JSX imports.
import type {
  TerminalShortcutModifier,
  TerminalShortcutSpecialKey
} from '../terminal/terminal-accessory-keys'

// Why: Alt is rendered with the ⌥ glyph because on macOS hosts the Option key
// is the only modifier that produces an ESC-prefixed byte sequence terminals
// can read. Cmd is intentionally absent — macOS swallows it before keystrokes
// reach the shell, so there's nothing to encode.
export const SHORTCUT_MODIFIERS: {
  id: TerminalShortcutModifier
  label: string
  glyph?: string
}[] = [
  { id: 'ctrl', label: 'Ctrl' },
  { id: 'alt', label: 'Alt', glyph: '⌥' },
  { id: 'shift', label: 'Shift' }
]

// Why: special keys are grouped by purpose so the picker reads as three small
// fixed grids rather than one ragged wrap row that clipped F7-F12.
export const SPECIAL_KEY_GROUPS: { title: string; ids: string[]; columns: number }[] = [
  {
    title: 'Editing',
    ids: ['escape', 'tab', 'enter', 'backspace', 'delete', 'insert', 'space'],
    columns: 4
  },
  {
    title: 'Navigation',
    ids: ['arrowUp', 'arrowDown', 'arrowLeft', 'arrowRight', 'home', 'end', 'pageUp', 'pageDown'],
    columns: 4
  },
  {
    title: 'Function',
    ids: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'],
    columns: 6
  }
]

export function indexSpecialKeys(
  keys: readonly TerminalShortcutSpecialKey[]
): Record<string, TerminalShortcutSpecialKey> {
  return Object.fromEntries(keys.map((key) => [key.id, key]))
}
