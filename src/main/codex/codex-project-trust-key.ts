// Why: Codex CLI writes Windows project-trust headers as TOML *literal* strings
// (single quotes, raw backslashes) while Orca writes *basic* strings (double
// quotes, escaped backslashes). Both decode to the same logical project path, so
// any "find or dedup an existing [projects....] section" must compare keys by
// their DECODED + normalized value. Comparing raw header text leaves two tables
// that decode to one TOML key, which makes Codex reject config.toml with a
// "duplicate key" load error.

function usesWindowsPathSeparators(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

// Why: content-based (not process.platform) — a WSL/SSH runtime home mirrored on
// a Windows host can hold POSIX project paths, which stay case-sensitive. Windows
// paths are separator- and case-insensitive, so fold both to one stable key.
export function normalizeProjectTrustKey(projectPath: string): string {
  return usesWindowsPathSeparators(projectPath)
    ? projectPath.replaceAll('/', '\\').toLowerCase()
    : projectPath
}

// Decode the quoted path inside a single `[projects.<quoted>]` table header,
// honoring both TOML basic (") and literal (') strings. Returns null when the
// line is not a single quoted project table header.
export function decodeProjectTableHeaderPath(header: string): string | null {
  const trimmed = header.trim()
  const prefix = /^\[[ \t]*projects[ \t]*\.[ \t]*/.exec(trimmed)
  if (!prefix) {
    return null
  }
  const parsed = parseSingleLineTomlString(trimmed, prefix[0].length)
  if (!parsed) {
    return null
  }
  let index = skipInlineWhitespace(trimmed, parsed.endIndex)
  if (trimmed[index] !== ']') {
    return null
  }
  index = skipInlineWhitespace(trimmed, index + 1)
  return index === trimmed.length || trimmed[index] === '#' ? parsed.value : null
}

// Decode + normalize in one step; null when `header` is not a project header.
export function getProjectTrustComparisonKey(header: string): string | null {
  const path = decodeProjectTableHeaderPath(header)
  return path === null ? null : normalizeProjectTrustKey(path)
}

type ParsedTomlString = {
  value: string
  endIndex: number
}

function parseSingleLineTomlString(line: string, startIndex: number): ParsedTomlString | null {
  if (line[startIndex] === '"') {
    return parseBasicString(line, startIndex + 1)
  }
  if (line[startIndex] === "'") {
    return parseLiteralString(line, startIndex + 1)
  }
  return null
}

function parseBasicString(line: string, startIndex: number): ParsedTomlString | null {
  let value = ''
  let index = startIndex
  while (index < line.length) {
    const char = line[index]
    if (char === '"') {
      return { value, endIndex: index + 1 }
    }
    if (char === '\\' && index + 1 < line.length) {
      value += unescapeBasicStringEscape(line[index + 1])
      index += 2
      continue
    }
    value += char
    index += 1
  }
  return null
}

// Why: literal strings take everything verbatim to the next single quote — TOML
// forbids escapes inside them, so raw backslashes stay raw.
function parseLiteralString(line: string, startIndex: number): ParsedTomlString | null {
  const endIndex = line.indexOf("'", startIndex)
  return endIndex === -1
    ? null
    : { value: line.slice(startIndex, endIndex), endIndex: endIndex + 1 }
}

function unescapeBasicStringEscape(next: string): string {
  if (next === 'n') {
    return '\n'
  }
  if (next === 'r') {
    return '\r'
  }
  if (next === 't') {
    return '\t'
  }
  if (next === 'b') {
    return '\b'
  }
  if (next === 'f') {
    return '\f'
  }
  if (next === '"') {
    return '"'
  }
  if (next === '\\') {
    return '\\'
  }
  // Why: unknown escapes round-trip — keep the backslash so a hand-edited config
  // never silently loses information.
  return `\\${next}`
}

function skipInlineWhitespace(line: string, startIndex: number): number {
  let index = startIndex
  while (line[index] === ' ' || line[index] === '\t') {
    index += 1
  }
  return index
}
