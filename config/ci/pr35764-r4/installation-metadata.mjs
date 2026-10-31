import { readlinkSync, realpathSync, lstatSync } from 'node:fs'
import { dirname, resolve, relative, isAbsolute, parse, sep } from 'node:path'

export function within(parent, child) {
  const rel = relative(parent, child)
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}
export function same(a, b) {
  return relative(a, b) === ''
}
export function containedFile(parent, path) {
  if (!within(parent, resolve(path))) {
    throw new Error(`R4 logical source escape: ${path}`)
  }
  const physical = realpathSync(path)
  if (!within(realpathSync(parent), physical)) {
    throw new Error(`R4 canonical source escape: ${path}`)
  }
  return physical
}
export function exists(path) {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}
export function links(path, seen = new Set(), depth = 0) {
  if (depth > 32) {
    throw new Error('N1 link chain exceeds bounded provenance inspection')
  }
  const absolute = resolve(path),
    parts = relative(parse(absolute).root, absolute).split(sep)
  let at = parse(absolute).root
  const result = []
  for (const part of parts) {
    at = resolve(at, part)
    if (seen.has(at)) {
      continue
    }
    seen.add(at)
    if (lstatSync(at).isSymbolicLink()) {
      const target = readlinkSync(at)
      result.push({ logical: at, target, canonical: realpathSync(at) })
      result.push(...links(resolve(dirname(at), target), seen, depth + 1))
    }
  }
  return result
}
// Only the relevant generated YAML mapping/scalar subset is accepted; no inferred defaults/schema.
export function scalar(text) {
  if (text === undefined) {
    throw new Error('N1 missing explicit metadata scalar')
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'")) {
      throw new Error('N1 unsupported quoted metadata')
    }
    return text.slice(1, -1).replaceAll("''", "'")
  }
  if (text.startsWith('"')) {
    return JSON.parse(text)
  }
  if (!text || /[\n\r]|^(?:[&*!|>{[])/.test(text) || /\s#/.test(text)) {
    throw new Error('N1 unsupported relevant metadata scalar: return actual source gap')
  }
  return text
}
export function fields(text, indent) {
  const lines = text.split('\n'),
    found = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '')
    if (!line.trim() || line.trimStart().startsWith('#') || line.search(/\S/) !== indent) {
      continue
    }
    const match = line.slice(indent).match(/^('(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|[^:]+):(?: (.*))?$/)
    if (!match) {
      throw new Error(`N1 unsupported relevant mapping: ${line}`)
    }
    let end = i + 1
    while (
      end < lines.length &&
      (!lines[end].trim() ||
        lines[end].trimStart().startsWith('#') ||
        lines[end].search(/\S/) > indent)
    ) {
      end++
    }
    const key = scalar(match[1])
    if (found.some((x) => x.key === key)) {
      throw new Error(`N1 duplicate relevant metadata key: ${key}`)
    }
    found.push({
      key,
      value: match[2],
      text: lines.slice(i, end).join('\n'),
      children: lines.slice(i + 1, end).join('\n')
    })
  }
  return found
}
export function field(text, indent, key, required = true) {
  const item = fields(text, indent).find((x) => x.key === key)
  if (!item && required) {
    throw new Error(`N1 missing actual generated/lock mapping: ${key}`)
  }
  return item
}
