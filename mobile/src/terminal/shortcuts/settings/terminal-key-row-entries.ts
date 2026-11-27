import type { TerminalAccessoryKey } from '../../key-input/terminal-accessory-keys'
import type { CustomKey } from '../../key-input/terminal-custom-keys'

/** The key's name; its glyph too when that says something the name doesn't ("Ctrl+C" beside Interrupt). */
export function keyName(key: TerminalAccessoryKey): { title: string; glyph?: string } {
  const title = key.accessibilityLabel ?? key.label
  const plain = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  return plain(title).startsWith(plain(key.label)) ? { title } : { title, glyph: key.label }
}

export function customKeyBytes(key: CustomKey): string {
  return key.bytes.replace(/\r/g, ' ↵')
}

/** `order` with the visible keys swapped into `visibleOrder`, so hidden keys keep their places. */
export function withVisibleOrder(
  order: string[],
  visible: Set<string>,
  visibleOrder: string[]
): string[] {
  let next = 0
  return order.map((id) => (visible.has(id) ? (visibleOrder[next++] ?? id) : id))
}
