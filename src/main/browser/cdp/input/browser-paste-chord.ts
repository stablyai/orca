import { parseCdpKeyEvent } from './cdp-keyboard-us-layout'

const CTRL_OR_META = 2 | 4
const SHIFT = 8
const PASTE_MODIFIER_NAMES = new Set(['control', 'ctrl', 'meta', 'cmd', 'command', 'super', 'win'])
const OTHER_MODIFIER_NAMES = new Set(['shift', 'alt'])

/** Whether a keypress key pastes from the clipboard, matching the actual key event including aliases. */
export function isPasteChord(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false
  }
  const event = parseCdpKeyEvent(value)
  if (event) {
    return (
      (event.code === 'KeyV' && (event.modifiers & CTRL_OR_META) !== 0) ||
      (event.code === 'Insert' && (event.modifiers & SHIFT) !== 0)
    )
  }
  // Unparsed spellings reach the raw driver, which takes modifiers from any position.
  const parts = value
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
  const modifiers = parts.filter(
    (part) => PASTE_MODIFIER_NAMES.has(part) || OTHER_MODIFIER_NAMES.has(part)
  )
  const key = parts.filter((part) => !modifiers.includes(part)).join('+')
  return (
    (key === 'v' && modifiers.some((modifier) => PASTE_MODIFIER_NAMES.has(modifier))) ||
    ((key === 'insert' || key === 'ins') && modifiers.includes('shift'))
  )
}
