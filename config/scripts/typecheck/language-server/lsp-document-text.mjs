// LSP positions count UTF-16 code units, which is what JavaScript string offsets count; lines end in \n, \r\n or \r.
function offsetAt(text, { line, character }) {
  let lineStart = 0
  for (let current = 0; current < line; current++) {
    const next = text.slice(lineStart).search(/\r\n|\r|\n/)
    if (next === -1) {
      return text.length
    }
    lineStart += next + (text.startsWith('\r\n', lineStart + next) ? 2 : 1)
  }
  const lineEnd = text.slice(lineStart).search(/\r|\n/)
  return lineStart + Math.min(character, lineEnd === -1 ? text.length - lineStart : lineEnd)
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
