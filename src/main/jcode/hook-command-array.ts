// Jcode accepts `event = ["a", "b"]`; edit elements in place so user layout and comments survive.
import type { Edit } from 'jsonc-parser'
import { parseTomlStringValue, type ParsedTomlString } from '../codex/config-toml-line-scan'

type HookCommandElement = ParsedTomlString & { comma: number | null }

export type JcodeHookCommandArray = {
  elements: HookCommandElement[]
  close: number
  /** Offset after the last token before `]`: `[`, an element, or its comma. */
  tailEnd: number
}

// Returns null for anything but an array of strings, which jcode would reject.
export function scanJcodeHookCommandArray(
  content: string,
  valueStart: number
): JcodeHookCommandArray | null {
  let index = valueStart
  while (content[index] === ' ' || content[index] === '\t') {
    index += 1
  }
  if (content[index] !== '[') {
    return null
  }
  const elements: HookCommandElement[] = []
  let tailEnd = index + 1
  index = skipTomlArrayTrivia(content, tailEnd)
  while (content[index] !== ']') {
    const parsed = parseTomlStringValue(content, index)
    if (!parsed) {
      return null
    }
    index = skipTomlArrayTrivia(content, parsed.end)
    const comma = content[index] === ',' ? index : null
    elements.push({ ...parsed, comma })
    tailEnd = comma === null ? parsed.end : comma + 1
    if (comma === null && content[index] !== ']') {
      return null
    }
    index = skipTomlArrayTrivia(content, tailEnd)
  }
  return { elements, close: index, tailEnd }
}

export function appendJcodeHookCommand(
  content: string,
  array: JcodeHookCommandArray,
  element: string
): Edit[] {
  const last = array.elements.at(-1)
  const trailingComma = last?.comma != null
  const closeLineStart = content.lastIndexOf('\n', array.close - 1) + 1
  if (!last || content.slice(closeLineStart, array.close).trim() !== '') {
    const text = !last ? element : trailingComma ? ` ${element},` : `, ${element}`
    return [{ offset: array.tailEnd, length: 0, content: text }]
  }
  // Multi-line array: add a line before `]`, matching the last element's indent and comma style.
  const lastLineStart = content.lastIndexOf('\n', last.start - 1) + 1
  const indent = /^[ \t]*/.exec(content.slice(lastLineStart))?.[0] ?? ''
  const eol = content[closeLineStart - 2] === '\r' ? '\r\n' : '\n'
  const line = `${indent}${element}${trailingComma ? ',' : ''}${eol}`
  return [
    ...(trailingComma ? [] : [{ offset: last.end, length: 0, content: ',' }]),
    { offset: closeLineStart, length: 0, content: line }
  ]
}

export function removeJcodeHookCommand(
  content: string,
  array: JcodeHookCommandArray,
  index: number
): Edit[] {
  const element = array.elements[index]
  const previousComma = array.elements[index - 1]?.comma ?? null
  const spacing = (offset: number): number => /^[ \t]*/.exec(content.slice(offset))?.[0].length ?? 0
  // A comma after a comment or newline is deleted on its own so the user's comments survive.
  const adjacentComma =
    element.comma !== null && element.end + spacing(element.end) === element.comma
      ? element.comma
      : null
  const stop = adjacentComma === null ? element.end : adjacentComma + 1
  const lineStart = content.lastIndexOf('\n', element.start - 1) + 1
  const lineEnd = content.indexOf('\n', element.end)
  const ownLine =
    lineEnd >= stop &&
    content.slice(lineStart, element.start).trim() === '' &&
    content.slice(stop, lineEnd).trim() === ''
  let start = element.start
  let end = stop
  let dropPreviousComma = element.comma === null && previousComma !== null
  if (ownLine) {
    start = lineStart
    end = lineEnd + 1
  } else if (
    previousComma !== null &&
    previousComma + 1 + spacing(previousComma + 1) === element.start
  ) {
    // Take the spacing after the previous comma (and that comma when last) so append then remove round-trips.
    start = element.comma === null ? previousComma : previousComma + 1
    dropPreviousComma = false
  } else if (adjacentComma !== null) {
    end += spacing(stop)
  }
  const edits: Edit[] = [{ offset: start, length: end - start, content: '' }]
  if (element.comma !== null && adjacentComma === null) {
    edits.push({ offset: element.comma, length: 1, content: '' })
  }
  // Removing the last element also drops the comma its predecessor gained on append.
  if (dropPreviousComma && previousComma !== null) {
    edits.push({ offset: previousComma, length: 1, content: '' })
  }
  return edits
}

function skipTomlArrayTrivia(content: string, offset: number): number {
  let index = offset
  while (index < content.length) {
    const char = content[index]
    if (char === '#') {
      const newline = content.indexOf('\n', index)
      index = newline === -1 ? content.length : newline
    } else if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
      index += 1
    } else {
      break
    }
  }
  return index
}
