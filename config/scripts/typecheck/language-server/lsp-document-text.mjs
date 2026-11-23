// LSP positions count UTF-16 code units, which is what JavaScript string offsets count; lines end in \n, \r\n or \r.
const LINE_BREAK = /\r\n|\r|\n/g

// Both ends of a range in one pass over the text up to the end's line.
function rangeOffsets(text, range) {
  LINE_BREAK.lastIndex = 0
  let line = 0
  let lineStart = 0
  let lastLine = false
  const offsetOf = ({ line: target, character }) => {
    while (line < target && !lastLine) {
      if (LINE_BREAK.exec(text) === null) {
        lastLine = true
      } else {
        lineStart = LINE_BREAK.lastIndex
        line++
      }
    }
    if (line < target) {
      return text.length
    }
    const resume = LINE_BREAK.lastIndex
    const lineBreak = LINE_BREAK.exec(text)
    LINE_BREAK.lastIndex = resume
    const lineEnd = lineBreak === null ? text.length : lineBreak.index
    return lineStart + Math.min(character, lineEnd - lineStart)
  }
  const start = offsetOf(range.start)
  return [start, Math.max(start, offsetOf(range.end))]
}

export function applyContentChanges(text, changes = []) {
  for (const change of changes) {
    if (!change.range) {
      text = change.text
      continue
    }
    const [start, end] = rangeOffsets(text, change.range)
    text = text.slice(0, start) + change.text + text.slice(end)
  }
  return text
}
