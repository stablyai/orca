// LSP positions count UTF-16 code units, which is what JavaScript string offsets count.
function offsetAt(text, { line, character }) {
  let lineStart = 0
  for (let current = 0; current < line; current++) {
    const newline = text.indexOf('\n', lineStart)
    if (newline === -1) {
      return text.length
    }
    lineStart = newline + 1
  }
  const lineEnd = text.indexOf('\n', lineStart)
  return Math.min(lineStart + character, lineEnd === -1 ? text.length : lineEnd)
}

export function applyContentChanges(text, changes = []) {
  for (const change of changes) {
    if (!change.range) {
      text = change.text
      continue
    }
    const start = offsetAt(text, change.range.start)
    const end = offsetAt(text, change.range.end)
    text = text.slice(0, start) + change.text + text.slice(end)
  }
  return text
}
