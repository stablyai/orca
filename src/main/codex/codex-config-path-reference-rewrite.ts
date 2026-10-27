import { posix as pathPosix, win32 as pathWin32 } from 'node:path'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  parseTomlSingleLineStringValue,
  updateTomlLineScanState
} from './config-toml-line-scan'

// Codex resolves these path settings against config.toml, including legacy instruction-file keys.
const EXACT_PATH_CONFIG_KEYS = new Set([
  'debug.config_lockfile.export_dir',
  'debug.config_lockfile.load_path',
  'experimental_compact_prompt_file',
  'experimental_instructions_file',
  'log_dir',
  'model_catalog_json',
  'model_instructions_file',
  'skills.config.path',
  'sqlite_home'
])

// Preserve original path targets when moving config.toml to a managed home.
// Inline tables, quoted keys and multiline strings pass through unchanged.
export function rewriteRelativePathConfigValues(config: string, sourceConfigDir: string): string {
  const lines = config.split('\n')
  let tablePath = ''
  let scanState = createTomlLineScanState()

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (isTomlStructuralLine(scanState)) {
      const header = getTomlTableHeader(line)
      if (header) {
        tablePath = getTomlHeaderPath(header)
      } else {
        lines[index] = rewriteRelativePathConfigLine(line, tablePath, sourceConfigDir)
      }
    }
    scanState = updateTomlLineScanState(scanState, line)
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

  // WSL reads config over UNC but consumes it in Linux; join using the source home's path style.
  const path = sourceConfigDir.startsWith('/') ? pathPosix : pathWin32
  const absolutePath = path.join(sourceConfigDir, parsed.value)
  return `${line.slice(0, parsed.start)}${quoteTomlPath(absolutePath)}${line.slice(parsed.end)}`
}

function isPathConfigKey(tablePath: string, key: string): boolean {
  const normalizedKey = normalizeTomlPathExpression(key)
  const fullPath = tablePath
    ? `${normalizeTomlPathExpression(tablePath)}.${normalizedKey}`
    : normalizedKey
  if (EXACT_PATH_CONFIG_KEYS.has(fullPath)) {
    return true
  }
  return (
    /^agents\..+\.config_file$/.test(fullPath) ||
    /^model_providers\..+\.auth\.cwd$/.test(fullPath) ||
    // Profile file settings also load during Codex startup.
    /^profiles\..+\.(?:experimental_compact_prompt_file|model_catalog_json|model_instructions_file)$/.test(
      fullPath
    )
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
  return canUseTomlLiteralString(value) ? `'${value}'` : quoteTomlBasicString(value)
}

// TOML literal strings forbid single quotes and control characters except tab.
function canUseTomlLiteralString(value: string): boolean {
  for (const char of value) {
    if (char === "'") {
      return false
    }
    const codePoint = char.codePointAt(0) ?? 0
    if ((codePoint < 0x20 && codePoint !== 0x09) || codePoint === 0x7f) {
      return false
    }
  }
  return true
}

function quoteTomlBasicString(value: string): string {
  let quoted = '"'
  for (const char of value) {
    if (char === '"' || char === '\\') {
      quoted += `\\${char}`
      continue
    }
    const codePoint = char.codePointAt(0) ?? 0
    if (codePoint < 0x20 || codePoint === 0x7f) {
      quoted += `\\u${codePoint.toString(16).toUpperCase().padStart(4, '0')}`
      continue
    }
    quoted += char
  }
  return `${quoted}"`
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
