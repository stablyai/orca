import { findNodeAtLocation, parseTree, type ParseError } from 'jsonc-parser'

/** The offset of the first character after spaces and comments from `index`. */
export function skipTrivia(text: string, index: number): number {
  let at = index
  while (at < text.length) {
    if (/\s/.test(text[at]!)) {
      at += 1
    } else if (text.startsWith('//', at)) {
      const end = text.indexOf('\n', at)
      at = end === -1 ? text.length : end
    } else if (text.startsWith('/*', at)) {
      const end = text.indexOf('*/', at + 2)
      at = end === -1 ? text.length : end + 2
    } else {
      break
    }
  }
  return at
}

/** Widens [start, end) to its whole lines when nothing else shares them. */
function wholeLines(text: string, start: number, end: number): [number, number] {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  const newline = text.indexOf('\n', end)
  const lineEnd = newline === -1 ? text.length : newline + 1
  const before = text.slice(lineStart, start)
  const after = text.slice(end, lineEnd)
  return before.trim() === '' && after.trim() === '' ? [lineStart, lineEnd] : [start, end]
}

/**
 * Removes the object property at `path` with its separating comma, taking its whole lines when it
 * has them to itself, so the rest of the text (indentation, comments, key order) stays as written.
 * Returns the text unchanged when the property isn't there.
 */
export function removeJsonProperty(text: string, path: readonly string[]): string {
  const errors: ParseError[] = []
  const tree = parseTree(text, errors, { allowTrailingComma: true })
  const property = tree ? findNodeAtLocation(tree, [...path])?.parent : undefined
  const siblings = property?.parent?.children
  if (!property || property.type !== 'property' || !siblings) {
    return text
  }
  const index = siblings.indexOf(property)
  const start = property.offset
  const end = property.offset + property.length
  const afterValue = skipTrivia(text, end)
  const previous = siblings[index - 1]
  if (text[afterValue] === ',' || !previous) {
    const [from, lineEnd] = wholeLines(text, start, text[afterValue] === ',' ? afterValue + 1 : end)
    let to = lineEnd
    // Inline, the text around it keeps one space, not two.
    while (from === start && (text[to] === ' ' || text[to] === '\t')) {
      to += 1
    }
    return text.slice(0, from) + text.slice(to)
  }
  // The last property: its comma is the one after the previous property.
  const comma = skipTrivia(text, previous.offset + previous.length)
  if (text[comma] !== ',') {
    return text
  }
  if (/^\s*$/.test(text.slice(comma + 1, start))) {
    return text.slice(0, comma) + text.slice(end)
  }
  const [from, to] = wholeLines(text, start, end)
  return text.slice(0, comma) + text.slice(comma + 1, from) + text.slice(to)
}
