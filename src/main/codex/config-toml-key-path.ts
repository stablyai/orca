import { parseTomlSingleLineStringValue } from './config-toml-line-scan'

export type ParsedTomlKeyPath = {
  segments: string[]
  end: number
}

export type ParsedTomlTableHeaderPath = ParsedTomlKeyPath & {
  isArray: boolean
}

export function parseTomlTableHeaderPath(header: string): ParsedTomlTableHeaderPath | null {
  const trimmed = header.trim()
  let source: string
  let isArray: boolean
  if (trimmed.startsWith('[[')) {
    if (!trimmed.endsWith(']]')) {
      return null
    }
    source = trimmed.slice(2, -2)
    isArray = true
  } else {
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']') || trimmed.endsWith(']]')) {
      return null
    }
    source = trimmed.slice(1, -1)
    isArray = false
  }
  const parsed = parseTomlKeyPath(source)
  if (!parsed || parsed.end !== source.length) {
    return null
  }
  return { ...parsed, isArray }
}

export function parseTomlKeyPath(source: string, offset = 0): ParsedTomlKeyPath | null {
  const segments: string[] = []
  let index = skipTomlKeyWhitespace(source, offset)
  while (index < source.length) {
    const quoted = parseTomlSingleLineStringValue(source, index)
    if (quoted) {
      segments.push(quoted.value)
      index = quoted.end
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(source.slice(index))
      if (!bare) {
        return null
      }
      segments.push(bare[0])
      index += bare[0].length
    }
    index = skipTomlKeyWhitespace(source, index)
    if (source[index] !== '.') {
      return { segments, end: index }
    }
    index = skipTomlKeyWhitespace(source, index + 1)
  }
  return null
}

function skipTomlKeyWhitespace(source: string, offset: number): number {
  let index = offset
  while (source[index] === ' ' || source[index] === '\t') {
    index += 1
  }
  return index
}
