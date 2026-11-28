/** Parse git `packed-refs` content line-by-line without allocating a `split('\n')` array. */
export function parsePackedRefsContent(content: string): Map<string, string> {
  const refs = new Map<string, string>()
  const len = content.length
  let lineStart = 0
  while (lineStart < len) {
    const nextNewline = content.indexOf('\n', lineStart)
    const lineEnd = nextNewline === -1 ? len : nextNewline
    if (lineEnd > lineStart) {
      const firstCode = content.charCodeAt(lineStart)
      // Skip '#' (35) comment lines and '^' (94) peeled-tag lines without slicing.
      if (firstCode !== 35 && firstCode !== 94) {
        const separator = content.indexOf(' ', lineStart)
        if (separator > lineStart && separator < lineEnd) {
          let refStart = separator + 1
          let refEnd = lineEnd
          while (refStart < refEnd && content.charCodeAt(refStart) <= 32) {
            refStart += 1
          }
          while (refEnd > refStart && content.charCodeAt(refEnd - 1) <= 32) {
            refEnd -= 1
          }
          refs.set(content.slice(refStart, refEnd), content.slice(lineStart, separator))
        }
      }
    }
    lineStart = nextNewline === -1 ? len : nextNewline + 1
  }
  return refs
}

// Repo-authored ref names must reject Windows separators/drive syntax before joining filesystem paths.
export function isSafeRefName(ref: string): boolean {
  const len = ref.length
  if (len === 0 || ref.includes('\\') || ref.includes(':')) {
    return false
  }
  let start = 0
  while (start <= len) {
    const slash = ref.indexOf('/', start)
    const end = slash === -1 ? len : slash
    const partLen = end - start
    if (
      partLen === 0 ||
      (partLen === 2 && ref.charCodeAt(start) === 46 && ref.charCodeAt(start + 1) === 46)
    ) {
      return false
    }
    if (slash === -1) {
      break
    }
    start = slash + 1
  }
  return true
}
