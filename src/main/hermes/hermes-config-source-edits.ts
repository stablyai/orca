import { isDeepStrictEqual } from 'node:util'
import { Document, isMap, isNode, isScalar, isSeq, parseDocument } from 'yaml'
import type { Node, YAMLMap, YAMLSeq } from 'yaml'

type SourceEdit = { start: number; end: number; text: string }

export const HERMES_EDITED_LISTS = [
  ['plugins', ['enabled', 'disabled']],
  ['terminal', ['client_env_passthrough']]
] as const

function columnAt(source: string, offset: number): number {
  return offset - source.lastIndexOf('\n', offset - 1) - 1
}

function indentFragment(fragment: string, difference: number): string {
  return fragment.replace(
    /\n( *)(?=\S)/g,
    (_match, spaces: string) => `\n${' '.repeat(Math.max(0, spaces.length + difference))}`
  )
}

// Comments parsed from a CRLF file keep their \r\n; callers add the file's line endings back.
function crlfToLf(text: string): string {
  return text.replaceAll('\r\n', '\n')
}

function requireRange(node: unknown): [number, number, number] {
  if (!isNode(node) || !node.range) {
    throw new Error('Missing Hermes YAML source range')
  }
  return node.range
}

function requirePair(map: YAMLMap, key: string) {
  const pair = map.items.find((item) => isNode(item.key) && item.key.toJSON() === key)
  if (!pair) {
    throw new Error(`Missing Hermes YAML key: ${key}`)
  }
  return pair
}

/** An empty, `~` or `null` key, e.g. `plugins:` with its only child commented out; Hermes reads it as unset. */
export function isUnsetHermesValue(node: unknown): boolean {
  return isScalar(node) && node.value === null && !node.anchor && !node.tag
}

/** Gives `key`, which has no value, its new one: inline in a flow mapping, else on the lines below the key. */
function fillUnsetValue(
  source: string,
  printed: string,
  parent: YAMLMap,
  key: string,
  value: Node
): SourceEdit {
  const pair = requirePair(parent, key)
  const [start, end] = requireRange(pair.value)
  if (parent.flow) {
    // JSON is valid flow YAML; a comment right after the value needs a space before its `#`.
    const text = `${JSON.stringify(value.toJSON())}${source[end] === '#' ? ' ' : ''}`
    return { start, end, text: source[start - 1] === ':' ? ` ${text}` : text }
  }
  const valueRange = requireRange(value)
  const column = columnAt(source, requireRange(pair.key)[0]) + 2
  const fragment = printed.slice(valueRange[0], valueRange[1]).replace(/\n$/, '')
  // Below the key's own line, so a comment that ends it stays where it is; a spelled-out null goes.
  const lineEnd = source.indexOf('\n', end)
  const stop = lineEnd === -1 ? source.length : lineEnd
  const position = source[stop - 1] === '\r' ? stop - 1 : stop
  const rest = source.slice(end, position)
  const spelledOut = end > start
  // Without a comment after it, the spelled-out null's leading whitespace goes too.
  const from = spelledOut && !rest.trim() ? source.slice(0, start).trimEnd().length : start
  const lineTail = spelledOut ? rest.trimStart() : rest
  return {
    start: from,
    end: position,
    text: `${lineTail}\n${' '.repeat(column)}${indentFragment(fragment, column - columnAt(printed, valueRange[0]))}`
  }
}

function insertPair(
  source: string,
  printed: string,
  parent: YAMLMap,
  updated: YAMLMap,
  key: string,
  enclosing: YAMLMap = parent
): SourceEdit {
  const pair = requirePair(updated, key)
  const keyRange = requireRange(pair.key)
  const valueRange = requireRange(pair.value)
  const parentRange = requireRange(parent)
  if (parent.flow) {
    const position = parentRange[1] - 1
    if (source[position] !== '}') {
      throw new Error('Unexpected Hermes flow mapping boundary')
    }
    const tail =
      parent.srcToken?.type === 'flow-collection' ? parent.srcToken.items.at(-1) : undefined
    const trailingComma =
      tail?.key === undefined &&
      tail?.sep === undefined &&
      tail?.value === undefined &&
      tail?.start.some((token) => token.type === 'comma')
    const separator = parent.items.length > 0 && !trailingComma ? ', ' : ' '
    // A flow closing brace may be outdented farther than an inserted entry or comma.
    const minimumColumn = enclosing.flow ? 0 : columnAt(source, requireRange(enclosing)[0]) + 1
    const column = columnAt(source, position)
    const linePrefix = source.slice(position - column, position)
    const spacesBeforeTab = /^( *)\t[ \t]*$/.exec(linePrefix)?.[1]?.length
    // Tabs are separation, so insufficient leading spaces require a fresh indented line.
    const padding =
      spacesBeforeTab !== undefined && spacesBeforeTab < minimumColumn
        ? `\n${' '.repeat(minimumColumn)}`
        : ' '.repeat(Math.max(0, minimumColumn - column))
    return {
      start: position,
      end: position,
      text: padding + separator + printed.slice(keyRange[0], valueRange[1])
    }
  }
  const column = columnAt(source, parentRange[0])
  const fragment = printed.slice(keyRange[0], valueRange[2])
  const prefix = parentRange[1] > 0 && source[parentRange[1] - 1] !== '\n' ? '\n' : ''
  const text = `${prefix}${' '.repeat(column)}${indentFragment(fragment, column - columnAt(printed, keyRange[0]))}`
  return {
    start: parentRange[1],
    end: parentRange[1],
    text: text.endsWith('\n') ? text : `${text}\n`
  }
}

export function applyHermesPluginSourceEdits(source: string, document: Document): string {
  const printed = document.toString({ lineWidth: 0 })
  const updated = parseDocument(printed)
  if (!isMap(parseDocument(source).contents)) {
    return source.includes('\r\n') ? crlfToLf(printed).replaceAll('\n', '\r\n') : printed
  }
  if (!isMap(updated.contents)) {
    throw new Error('Missing updated Hermes mapping')
  }
  // Why: a replaced list's range can run past the root mapping, where another section inserts.
  let result = source
  for (const [sectionKey, keys] of HERMES_EDITED_LISTS) {
    result = applySectionEdits(result, printed, document, updated.contents, sectionKey, keys)
  }
  return result
}

function applySectionEdits(
  source: string,
  printed: string,
  document: Document,
  updatedRoot: YAMLMap,
  sectionKey: string,
  keys: readonly string[]
): string {
  const original = parseDocument(source, { keepSourceTokens: true })
  if (!isMap(original.contents)) {
    throw new Error('Unexpected Hermes root mapping')
  }
  const section = original.get(sectionKey, true)
  const updatedSection = updatedRoot.get(sectionKey, true)
  // Edited sections are always mappings; anything else was left untouched.
  if (!isMap(updatedSection)) {
    return source
  }
  const edits: SourceEdit[] = []
  if (section === undefined) {
    edits.push(insertPair(source, printed, original.contents, updatedRoot, sectionKey))
  } else if (isUnsetHermesValue(section)) {
    edits.push(fillUnsetValue(source, printed, original.contents, sectionKey, updatedSection))
  } else {
    if (!isMap(section)) {
      throw new Error(`Unexpected Hermes ${sectionKey} mapping`)
    }
    for (const key of keys) {
      const previous = section.get(key, true)
      const next = updatedSection.get(key, true)
      if (!isNode(next)) {
        continue
      }
      if (previous === undefined) {
        edits.push(insertPair(source, printed, section, updatedSection, key, original.contents))
      } else if (isUnsetHermesValue(previous)) {
        // A list key the update left unset reads back as the same null.
        if (isSeq(next)) {
          edits.push(fillUnsetValue(source, printed, section, key, next))
        }
      } else if (isNode(previous) && !isDeepStrictEqual(previous.toJSON(), next.toJSON())) {
        const edited = document.createNode(document.getIn([sectionKey, key], true))
        if (!isSeq(edited)) {
          throw new Error(`Missing edited Hermes ${sectionKey} list`)
        }
        edits.push(replaceNode(source, section, previous, edited))
      }
    }
  }
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  let result = source
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    result =
      result.slice(0, edit.start) + edit.text.replaceAll('\n', newline) + result.slice(edit.end)
  }
  return result
}

function replaceNode(source: string, parent: YAMLMap, previous: Node, next: YAMLSeq): SourceEdit {
  const before = requireRange(previous)
  // YAML ranges can include the next key's indentation after a trailing comment.
  const trailingIndent =
    /(?:^|\n)([ \t]+)$/.exec(source.slice(before[0], before[2]))?.[1].length ?? 0
  const end = before[2] - trailingIndent
  // Printing only this list keeps neighboring comments out of its replacement.
  const isolated = new Document()
  const sequence = next.clone()
  if (!isSeq(sequence)) {
    throw new Error('Missing cloned Hermes plugin list')
  }
  isolated.contents = sequence
  // The original leading comment remains outside the replaced source range.
  isolated.contents.commentBefore = undefined
  let fragment = crlfToLf(isolated.toString({ lineWidth: 0 }))
  if (!source.slice(before[0], end).endsWith('\n') && !next.comment) {
    fragment = fragment.replace(/\n$/, '')
  }
  const column = columnAt(source, before[0])
  // Empty flow lists cannot use a block sequence's indentless position.
  const replacementColumn =
    isSeq(previous) && !previous.flow && (next.flow || next.items.length === 0)
      ? Math.max(column, columnAt(source, requireRange(parent)[0]) + 2)
      : column
  return {
    start: before[0],
    end,
    text: ' '.repeat(replacementColumn - column) + indentFragment(fragment, replacementColumn)
  }
}
