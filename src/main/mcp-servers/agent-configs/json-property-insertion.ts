import { findNodeAtLocation, parseTree, type Node } from 'jsonc-parser'
import { skipTrivia } from './json-property-removal'

function lineIndent(text: string, offset: number): string {
  return /^[ \t]*/.exec(text.slice(text.lastIndexOf('\n', offset - 1) + 1))?.[0] ?? ''
}

/**
 * Adds `name: value` as the last property of the object at `path`, indented like its siblings. Only
 * the new text goes in (no reformatting), so `removeJsonProperty` takes back exactly these bytes.
 * Null when there's no object at `path`.
 */
export function insertJsonProperty(
  text: string,
  path: readonly string[],
  name: string,
  value: unknown
): string | null {
  const tree = parseTree(text, [], { allowTrailingComma: true })
  const object: Node | undefined =
    tree && path.length > 0 ? findNodeAtLocation(tree, [...path]) : tree
  if (!object || object.type !== 'object') {
    return null
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const outer = lineIndent(text, object.offset)
  const last = object.children?.at(-1)
  const indent = last ? lineIndent(text, last.offset) : `${outer}  `
  const unit = indent.length > outer.length ? indent.slice(outer.length) : '  '
  const property = `${JSON.stringify(name)}: ${JSON.stringify(value, null, unit)
    .split('\n')
    .join(eol + indent)}`
  if (!last) {
    // An empty object: the property goes on its own line before `}`, after any comment inside.
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
