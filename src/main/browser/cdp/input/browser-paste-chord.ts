import { parseCdpKeyEvent } from './cdp-keyboard-us-layout'

const CTRL_OR_META = 2 | 4
const SHIFT = 8
const PASTE_MODIFIER_NAMES = new Set(['control', 'ctrl', 'meta', 'cmd', 'command', 'super', 'win'])

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
  // Unparsed spellings reach the raw driver; check their paste aliases too.
  const parts = value
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
  const key = parts.at(-1)
  const modifiers = parts.slice(0, -1)
  return (
    (key === 'v' && modifiers.some((modifier) => PASTE_MODIFIER_NAMES.has(modifier))) ||
    ((key === 'insert' || key === 'ins') && modifiers.includes('shift'))
  )
}
