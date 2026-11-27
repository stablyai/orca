import { findNodeAtLocation, parseTree, type Node } from 'jsonc-parser'

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
  return path.length === 0 ? text : removeJsonProperties(text, path.slice(0, -1), [path.at(-1)!])
}

/** `removeJsonProperty` for each of `names` in the object at `path`, from one parse. */
export function removeJsonProperties(
  text: string,
  path: readonly string[],
  names: readonly string[]
): string {
  if (names.length === 0) {
    return text
  }
  const tree = parseTree(text, [], { allowTrailingComma: true })
  const object = tree && path.length > 0 ? findNodeAtLocation(tree, [...path]) : tree
  const siblings = object?.type === 'object' ? object.children : undefined
  if (!siblings) {
    return text
  }
  // The first property by each name, as a lookup by path would find it.
  const wanted = new Set(names)
  const removing: number[] = []
  for (let index = 0; index < siblings.length && wanted.size > 0; index++) {
    const property = siblings[index]!
    const key = property.children?.length === 2 ? property.children[0]!.value : undefined
    if (typeof key === 'string' && wanted.delete(key)) {
      removing.push(index)
    }
  }
  // Last first, so every offset still to be used lies before the text already cut.
  let next = text
  for (const index of removing.toReversed()) {
    next = removeProperty(next, siblings[index]!, siblings[index - 1])
  }
  return next
}

/** Removes the property at `path` only while its value is `{}` with nothing inside, not even a comment. */
export function removeEmptyJsonObjectProperty(text: string, path: readonly string[]): string {
  const tree = parseTree(text, [], { allowTrailingComma: true })
  const value = tree && path.length > 0 ? findNodeAtLocation(tree, [...path]) : undefined
  const property = value?.parent
  const siblings = property?.parent?.children
  if (
    value?.type !== 'object' ||
    property?.type !== 'property' ||
    !siblings ||
    text.slice(value.offset + 1, value.offset + value.length - 1).trim() !== ''
  ) {
    return text
  }
  return removeProperty(text, property, siblings[siblings.indexOf(property) - 1])
}

function removeProperty(text: string, property: Node, previous: Node | undefined): string {
  const start = property.offset
  const end = property.offset + property.length
  const afterValue = skipTrivia(text, end)
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
