import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { posix as pathPosix, win32 as pathWin32 } from 'node:path'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  parseTomlSingleLineStringValue,
  updateTomlLineScanState
} from './config-toml-line-scan'

// Why: codex-rs types these settings AbsolutePathBuf and resolves relative
// values against the defining config.toml's directory (= CODEX_HOME for the
// user config). experimental_instructions_file only exists in older Codex
// releases; keeping it is harmless since Codex ignores unknown keys.
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

// Why: Orca mirrors config.toml into a managed CODEX_HOME, but Codex resolves
// path-valued config settings from the file it read. Keep user-owned assets in
// ~/.codex reachable after the mirror moves the TOML. Best-effort by design:
// values spelled as inline tables, quoted keys, or triple-quoted strings pass
// through unchanged rather than risk corrupting them.
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

  // Why: WSL configs are read over UNC paths but consumed inside Linux, so
  // join semantics must follow the source home's path style, not the host's.
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
    // Why: profiles mirror the top-level file settings that Codex reads (and
    // can abort on) during config load.
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

// Why: TOML literal strings allow tab but no other control chars and no
// single quote; anything else must go through an escaped basic string.
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

// Why: these settings must resolve inside whichever CODEX_HOME is *active*, not
// against the directory of the file that declared them. That is the opposite of
// EXACT_PATH_CONFIG_KEYS above, which anchors relative values to the SOURCE home
// so user-owned assets stay reachable after the mirror moves the TOML.
//
// A bundled marketplace only loads when its source sits inside the active home,
// so copying `~/.codex/.tmp/bundled-marketplaces/...` verbatim silently drops
// the plugin from Orca-launched Codex (#18682). Adding such a key to the
// anchoring set would cement the bug rather than fix it.
// DELIBERATELY NOT LISTED: `mcp_servers.*.env.NODE_REPL_TRUSTED_CODE_PATHS` and
// `NODE_REPL_TRUSTED_SERVICES`, even though #18682 asks for all four keys.
//
// Those two are a third-party MCP server's allowlist of locations trusted to
// EXECUTE, not paths that merely need to resolve. Re-pointing them would widen
// what a tool is permitted to run, on the user's behalf and without telling
// them — a decision for the user, not a path fix.
//
// The cost is real and is accepted knowingly: wherever the marketplace rewrite
// below fires, code runs from the runtime home while the allowlist still names
// the source home, so the two disagree — and this change is what creates that
// disagreement. Before it, both pointed at the source home and were
// consistently wrong. Revisit deliberately; do not quietly complete the list.
const HOME_LOCAL_PATH_CONFIG_PATTERNS = [
  // Why the restricted segment rather than `.+`: a greedy match spans dots, so
  // `[marketplaces.x.auth] source` would also be re-rooted onto a directory the
  // mirror never copies. Marketplace names are single TOML key segments.
  /^marketplaces\.[^.]+\.source$/,
  /^mcp_servers\.[^.]+\.env\.CODEX_HOME$/
]

function isHomeLocalPathConfigKey(tablePath: string, key: string): boolean {
  const normalizedKey = normalizeTomlPathExpression(key)
  const fullPath = tablePath
    ? `${normalizeTomlPathExpression(tablePath)}.${normalizedKey}`
    : normalizedKey
  return HOME_LOCAL_PATH_CONFIG_PATTERNS.some((pattern) => pattern.test(fullPath))
}

/**
 * WSL is out of scope, declared rather than accidental.
 *
 * A WSL source home arrives as a Windows-side UNC path while the config is read
 * inside the distro, and the runtime home paired with it is Windows-side too.
 * The rewrite happens to no-op there on a POSIX host — but on a Windows host
 * with a per-account runtime home that really has the directory, the paths
 * resolve and a UNC or drive path would be written into a config consumed from
 * inside Linux, which is worse than leaving the value alone. Re-rooting for WSL
 * needs a Linux-side runtime home, which this seam does not have.
 *
 * Lives here rather than at the mirror because it is a property of path
 * flavour, and because here it sits behind the injectable existence probe —
 * which is what lets a test hold it as the only reason a WSL value is refused.
 */
function isHomeLocalRewriteSupported(sourceHomePath: string, runtimeHomePath: string): boolean {
  return !parseWslUncPath(sourceHomePath) && !parseWslUncPath(runtimeHomePath)
}

/**
 * Re-roots home-local settings from the source CODEX_HOME onto the runtime one.
 *
 * Only values that actually live inside the source home are moved; anything
 * pointing elsewhere is the user's own path and is left exactly as written.
 *
 * Conditional on the rewritten target existing, and that is the whole safety
 * argument. A bundled marketplace is recognised only when its source sits inside
 * the active home — but Codex materialises that directory itself, per home, and
 * a home that never received one has nothing to point at. Rewriting there would
 * trade "points at the wrong home, but the path resolves" for "points at
 * nothing", which is strictly worse. Rewriting only when the target is really
 * present makes this no worse than today in every case, and better wherever the
 * directory exists.
 */
export function rewriteHomeLocalConfigValues(
  config: string,
  sourceHomePath: string,
  runtimeHomePath: string,
  targetExists: (path: string) => boolean = existsSync
): string {
  if (!sourceHomePath || !runtimeHomePath || sourceHomePath === runtimeHomePath) {
    return config
  }
  if (!isHomeLocalRewriteSupported(sourceHomePath, runtimeHomePath)) {
    return config
  }
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
        lines[index] = rewriteHomeLocalConfigLine(
          line,
          tablePath,
          sourceHomePath,
          runtimeHomePath,
          targetExists
        )
      }
    }
    scanState = updateTomlLineScanState(scanState, line)
  }

  return lines.join('\n')
}

function rewriteHomeLocalConfigLine(
  line: string,
  tablePath: string,
  sourceHomePath: string,
  runtimeHomePath: string,
  targetExists: (path: string) => boolean
): string {
  const equalsIndex = line.indexOf('=')
  if (equalsIndex === -1) {
    return line
  }
  const key = line.slice(0, equalsIndex).trim()
  if (!isHomeLocalPathConfigKey(tablePath, key)) {
    return line
  }
  const parsed = parseTomlSingleLineStringValue(line, equalsIndex + 1)
  if (!parsed) {
    return line
  }
  const moved = reRootHomeLocalPath(parsed.value, sourceHomePath, runtimeHomePath)
  // Why the existence check: see rewriteHomeLocalConfigValues. Pointing at a
  // directory that was never materialised is worse than the wrong-home path it
  // would replace, because that one at least resolves.
  //
  // Deliberately a presence test, not a directory test: a regular file sitting
  // at the target would satisfy it. Nothing Orca or Codex writes puts a file
  // there, and tightening it would trade a real guarantee for a hypothetical.
  // Note also that for `mcp_servers.*.env.CODEX_HOME` the target IS the runtime
  // home, which always exists — so that key is re-rooted unconditionally, and
  // the no-worse-than-today guarantee covers `marketplaces.*.source` alone.
  if (moved === null || !targetExists(moved)) {
    return line
  }
  return `${line.slice(0, parsed.start)}${quoteTomlPath(moved)}${line.slice(parsed.end)}`
}

/** Null when the value is not inside the source home, so it stays untouched. */
function reRootHomeLocalPath(
  value: string,
  sourceHomePath: string,
  runtimeHomePath: string
): string | null {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  // Why: both homes are backslash paths on Windows, where posix `relative`
  // returns `../C:\Users\...` and the guard below rejects every value — the fix
  // would be a silent no-op. Pick the flavour from the home's shape, exactly as
  // the relative-path rewrite above does for its source directory.
  const path = sourceHomePath.startsWith('/') ? pathPosix : pathWin32
  const expanded = trimmed.startsWith('~/') ? path.join(homedir(), trimmed.slice(2)) : trimmed
  const relative = path.relative(sourceHomePath, expanded)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null
  }
  return relative ? path.join(runtimeHomePath, relative) : runtimeHomePath
}
