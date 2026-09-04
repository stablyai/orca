/** Codex paints `>_ OpenAI Codex` + `model:` + `directory:` rows before its composer takes input,
 *  with `loading` values; only the settled header is readiness for `tui-idle`. */
export function findCodexReadyPromptIndex(normalized: string): number | null {
  const headerIndex = normalized.lastIndexOf('openai codex')
  if (headerIndex === -1) {
    return null
  }
  const readySegment = normalized.slice(headerIndex)
  // Why: Codex prints permissions only in YOLO mode; the stable ready header is OpenAI Codex + model + directory.
  // Why last occurrence: a repaint appends the settled row after the booting one in a stacked tail.
  const modelIndex = findLastCodexHeaderFieldIndex(readySegment, 'model:')
  const directoryIndex = findLastCodexHeaderFieldIndex(readySegment, 'directory:')
  if (modelIndex === null || directoryIndex === null) {
    return null
  }
  // Why: the same header is painted with `model: loading` / `directory: loading` while Codex boots
  // and its composer does not take input yet; only settled values are readiness.
  if (
    codexHeaderValueIsUnsettled(readySegment, modelIndex + 'model:'.length) ||
    codexHeaderValueIsUnsettled(readySegment, directoryIndex + 'directory:'.length)
  ) {
    return null
  }
  return headerIndex
}

// Why line-anchored: a directory value can itself contain `model:`; only a label that opens a row is
// a header field, and the last such row is the one Codex painted most recently.
function findLastCodexHeaderFieldIndex(segment: string, label: string): number | null {
  let last: number | null = null
  let lineStart = 0
  while (lineStart <= segment.length) {
    const lineEnd = segment.indexOf('\n', lineStart)
    const line = segment.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
    const labelOffset = line.length - line.trimStart().length
    if (line.startsWith(label, labelOffset)) {
      last = lineStart + labelOffset
    }
    if (lineEnd === -1) {
      break
    }
    lineStart = lineEnd + 1
  }
  return last
}

function codexHeaderValueIsUnsettled(segment: string, valueStart: number): boolean {
  const lineEnd = segment.indexOf('\n', valueStart)
  const value = segment.slice(valueStart, lineEnd === -1 ? undefined : lineEnd).trim()
  return value.length === 0 || value.startsWith('loading')
}
