import { parseTree } from 'jsonc-parser'
import { findActiveJsonNode, skipTrivia } from './json-property-removal'

function lineIndent(text: string, offset: number): string {
  return /^[ \t]*/.exec(text.slice(text.lastIndexOf('\n', offset - 1) + 1))?.[0] ?? ''
}

/**
 * Adds each `[name, value]`, in order, as the last properties of the object at `path`, indented like
 * their siblings, from one parse. Only the new text goes in (no reformatting), so
 * `removeJsonProperties` takes back exactly these bytes. Null when there's no object at `path`.
 */
export function insertJsonProperties(
  text: string,
  path: readonly string[],
  properties: readonly (readonly [string, unknown])[]
): string | null {
  const tree = parseTree(text, [], { allowTrailingComma: true })
  const object = findActiveJsonNode(tree, path)
  if (!object || object.type !== 'object') {
    return null
  }
  if (properties.length === 0) {
    return text
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const outer = lineIndent(text, object.offset)
  const last = object.children?.at(-1)
  const indent = last ? lineIndent(text, last.offset) : `${outer}  `
  const unit = indent.length > outer.length ? indent.slice(outer.length) : '  '
  const property = properties
    .map(
      ([name, value]) =>
        `${JSON.stringify(name)}: ${JSON.stringify(value, null, unit)
          .split('\n')
          .join(eol + indent)}`
    )
    .join(`,${eol}${indent}`)
  if (!last) {
    // An empty object: the properties go on their own lines before `}`, after any comment inside.
    const close = object.offset + object.length - 1
    const inside = text.slice(object.offset + 1, close).trimEnd()
    return `${text.slice(0, object.offset + 1)}${inside}${eol}${indent}${property}${eol}${outer}${text.slice(close)}`
  }
  const end = last.offset + last.length
  const after = skipTrivia(text, end)
  // A trailing comma the user left stays where it is; the new property follows it.
  return text[after] === ','
    ? `${text.slice(0, after + 1)}${eol}${indent}${property}${text.slice(after + 1)}`
    : `${text.slice(0, end)},${eol}${indent}${property}${text.slice(end)}`
}
