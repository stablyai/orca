import { utf8Head } from './journal-payload-bounds'

export function relayAskSelection(label: string, description: string, reference: string): string {
  const full = description ? `${label} — ${description}` : label
  if (Buffer.byteLength(full, 'utf8') <= 1024) {
    return full
  }
  const tail = `… [cut; ${reference}]`
  return utf8Head(full, Math.max(0, 1024 - Buffer.byteLength(tail))) + tail
}
