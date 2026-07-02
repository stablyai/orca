import { join, posix as pathPosix, win32 as pathWin32 } from 'node:path'

const TOP_LEVEL_PATH_CONFIG_KEYS = new Set([
  'experimental_compact_prompt_file',
  'experimental_instructions_file',
  'log_dir',
  'model_catalog_json',
  'model_instructions_file',
  'sqlite_home'
])

type TomlMultilineState = {
  basic: boolean
  literal: boolean
}

type TomlMultilineMode = 'basic' | 'literal' | null

type ParsedTomlString = {
  value: string
  start: number
  end: number
}

// Why: Orca mirrors config.toml into a managed CODEX_HOME, but Codex resolves
// path-valued config settings from the file it read. Keep user-owned assets in
// ~/.codex reachable after the mirror moves the TOML.
export function rewriteRelativePathConfigValues(config: string, sourceConfigDir: string): string {
  const lines = config.split('\n')
  let tablePath = ''
  let multilineState: TomlMultilineState = { basic: false, literal: false }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (!isInsideTomlMultilineString(multilineState)) {
      const header = getTomlTableHeader(line)
      if (header) {
        tablePath = getTomlHeaderPath(header)
      } else {
        lines[index] = rewriteRelativePathConfigLine(line, tablePath, sourceConfigDir)
      }
    }
    multilineState = updateTomlMultilineState(multilineState, line)
  }

  return lines.join('\n')
}

function rewriteRelativePathConfigLine(
  line: string,
  tablePath: string,
  sourceConfigDir: string
): string {
  const equalsIndex = line.indexOf('=')
  if (equalsIndex === -1) {
    return line
  }

  const key = line.slice(0, equalsIndex).trim()
  if (!isPathConfigKey(tablePath, key)) {
    return line
  }

  const parsed = parseTomlSingleLineStringValue(line, equalsIndex + 1)
  if (!parsed || !shouldRewriteRelativePath(parsed.value)) {
    return line
  }

  const absolutePath = join(sourceConfigDir, parsed.value)
  return `${line.slice(0, parsed.start)}${quoteTomlPath(absolutePath)}${line.slice(parsed.end)}`
}

function isPathConfigKey(tablePath: string, key: string): boolean {
  const normalizedKey = normalizeTomlPathExpression(key)
  const fullPath = tablePath
    ? `${normalizeTomlPathExpression(tablePath)}.${normalizedKey}`
    : normalizedKey
  if (TOP_LEVEL_PATH_CONFIG_KEYS.has(fullPath)) {
    return true
  }
  return (
    /^agents\..+\.config_file$/.test(fullPath) ||
    /^model_providers\..+\.auth\.cwd$/.test(fullPath) ||
    fullPath === 'skills.config.path'
  )
}

function normalizeTomlPathExpression(value: string): string {
  return value.replace(/\s+/g, '')
}

function shouldRewriteRelativePath(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || trimmed.startsWith('~') || trimmed.startsWith('$') || trimmed.startsWith('%')) {
    return false
  }
  if (pathWin32.isAbsolute(trimmed) || pathPosix.isAbsolute(trimmed)) {
    return false
  }
  return !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)
}

function quoteTomlPath(value: string): string {
  if (!value.includes("'") && !value.includes('\n') && !value.includes('\r')) {
    return `'${value}'`
  }
  return JSON.stringify(value)
}

function parseTomlSingleLineStringValue(line: string, offset: number): ParsedTomlString | null {
  let index = offset
  while (line[index] === ' ' || line[index] === '\t') {
    index += 1
  }

  if (line.startsWith('"""', index) || line.startsWith("'''", index)) {
    return null
  }

  const quote = line[index]
  if (quote !== '"' && quote !== "'") {
    return null
  }

  const start = index
  index += 1
  let value = ''
  while (index < line.length) {
    const char = line[index]
    if (char === quote) {
      return { value, start, end: index + 1 }
    }
    if (quote === '"' && char === '\\') {
      const escaped = parseTomlBasicStringEscape(line, index)
      if (!escaped) {
        return null
      }
      value += escaped.value
      index = escaped.nextIndex
      continue
    }
    value += char
    index += 1
  }
  return null
}

function parseTomlBasicStringEscape(
  line: string,
  slashIndex: number
): { value: string; nextIndex: number } | null {
  const escaped = line[slashIndex + 1]
  switch (escaped) {
    case 'b':
      return { value: '\b', nextIndex: slashIndex + 2 }
    case 't':
      return { value: '\t', nextIndex: slashIndex + 2 }
    case 'n':
      return { value: '\n', nextIndex: slashIndex + 2 }
    case 'f':
      return { value: '\f', nextIndex: slashIndex + 2 }
    case 'r':
      return { value: '\r', nextIndex: slashIndex + 2 }
    case '"':
    case '\\':
      return { value: escaped, nextIndex: slashIndex + 2 }
    case 'u':
      return parseTomlUnicodeEscape(line, slashIndex + 2, 4)
    case 'U':
      return parseTomlUnicodeEscape(line, slashIndex + 2, 8)
    default:
      return null
  }
}

function parseTomlUnicodeEscape(
  line: string,
  start: number,
  length: number
): { value: string; nextIndex: number } | null {
  const raw = line.slice(start, start + length)
  if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(raw)) {
    return null
  }
  const codePoint = Number.parseInt(raw, 16)
  try {
    return { value: String.fromCodePoint(codePoint), nextIndex: start + length }
  } catch {
    return null
  }
}

function getTomlHeaderPath(header: string): string {
  const trimmed = header.trim()
  if (trimmed.startsWith('[[') && trimmed.endsWith(']]')) {
    return trimmed.slice(2, -2).trim()
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1).trim()
  }
  return ''
}

function getTomlTableHeader(line: string): string | null {
  const match = /^(\s*\[\[?.+\]\]?\s*)(?:#.*)?$/.exec(line)
  return match?.[1] ?? null
}

function isInsideTomlMultilineString(state: TomlMultilineState): boolean {
  return state.basic || state.literal
}

function updateTomlMultilineState(state: TomlMultilineState, line: string): TomlMultilineState {
  let mode: TomlMultilineMode = state.basic ? 'basic' : state.literal ? 'literal' : null
  let index = 0
  while (index < line.length) {
    if (mode === 'basic') {
      if (line[index] === '\\') {
        index += 2
        continue
      }
      if (line.startsWith('"""', index)) {
        mode = null
        index += 3
        continue
      }
      index += 1
      continue
    }
    if (mode === 'literal') {
      if (line.startsWith("'''", index)) {
        mode = null
        index += 3
        continue
      }
      index += 1
      continue
    }

    const char = line[index]
    if (char === '#') {
      break
    }
    if (line.startsWith('"""', index)) {
      mode = 'basic'
      index += 3
      continue
    }
    if (line.startsWith("'''", index)) {
      mode = 'literal'
      index += 3
      continue
    }
    if (char === '"') {
      index = skipTomlBasicString(line, index + 1)
      continue
    }
    if (char === "'") {
      index = skipTomlLiteralString(line, index + 1)
      continue
    }
    index += 1
  }
  return { basic: mode === 'basic', literal: mode === 'literal' }
}

function skipTomlBasicString(line: string, startIndex: number): number {
  let index = startIndex
  while (index < line.length) {
    const char = line[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === '"') {
      return index + 1
    }
    index += 1
  }
  return index
}

function skipTomlLiteralString(line: string, startIndex: number): number {
  const endIndex = line.indexOf("'", startIndex)
  return endIndex === -1 ? line.length : endIndex + 1
}
