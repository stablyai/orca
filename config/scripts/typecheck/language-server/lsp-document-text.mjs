// LSP positions count UTF-16 code units, which is what JavaScript string offsets count; lines end in \n, \r\n or \r.
const LINE_BREAK = /\r\n|\r|\n/g

// One pass over the text before the position; building the edited string is linear in the document anyway.
function offsetAt(text, { line, character }) {
  LINE_BREAK.lastIndex = 0
  let lineStart = 0
  for (let current = 0; current < line; current++) {
    const match = LINE_BREAK.exec(text)
    if (match === null) {
      return text.length
    }
    lineStart = LINE_BREAK.lastIndex
  }
  const end = LINE_BREAK.exec(text)
  const lineEnd = end === null ? text.length : end.index
  return lineStart + Math.min(character, lineEnd - lineStart)
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
