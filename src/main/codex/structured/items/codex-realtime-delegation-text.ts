// Codex's voice model hands speech to the thread wrapped in <realtime_delegation> (codex-rs
// core/src/context/realtime_delegation.rs), and Codex's contextual-fragment filter does not hide it.
// The parsing follows the Codex TUI's realtime_delegation_input.

const OPEN = '<realtime_delegation>'
const CLOSE = '</realtime_delegation>'
const INPUT_OPEN = '<input>'
const INPUT_CLOSE = '</input>'

/** The request the voice model handed to the thread, unescaped; null when the text is not one. */
export function codexRealtimeDelegationInput(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith(OPEN) || !trimmed.endsWith(CLOSE)) {
    return null
  }
  const body = trimmed.slice(OPEN.length, trimmed.length - CLOSE.length)
  const start = body.indexOf(INPUT_OPEN)
  const end = start === -1 ? -1 : body.indexOf(INPUT_CLOSE, start + INPUT_OPEN.length)
  if (end === -1) {
    return null
  }
  return body
    .slice(start + INPUT_OPEN.length, end)
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}
