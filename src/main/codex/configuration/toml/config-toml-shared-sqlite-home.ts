import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  parseTomlSingleLineStringValue,
  updateTomlLineScanState
} from './config-toml-line-scan'

// An account home's databases live with the shared history store; the line is Orca's, per home.
export const CODEX_SHARED_SQLITE_HOME_MARKER = '# orca: Codex history shared across accounts'

/** Remove Orca's line so it never reaches the user's own ~/.codex config. */
export function stripCodexSharedSqliteHome(config: string): string {
  if (!config.includes(CODEX_SHARED_SQLITE_HOME_MARKER)) {
    return config
  }
  let scan = createTomlLineScanState()
  const kept: string[] = []
  for (const line of config.split('\n')) {
    const structural = isTomlStructuralLine(scan)
    scan = updateTomlLineScanState(scan, line)
    if (structural && line.trimEnd().endsWith(CODEX_SHARED_SQLITE_HOME_MARKER)) {
      continue
    }
    kept.push(line)
  }
  return kept.join('\n')
}

/** The store path in Orca's own line, or null when the config has none. */
export function readCodexSharedSqliteHome(config: string): string | null {
  const line = findTopLevelSqliteHomeLine(config)
  if (line) {
    const match = /^sqlite_home = (".*") # orca: /.exec(line.trimEnd())
    if (match && line.trimEnd().endsWith(CODEX_SHARED_SQLITE_HOME_MARKER)) {
      try {
        const value: unknown = JSON.parse(match[1])
        return typeof value === 'string' ? value : null
      } catch {
        return null
      }
    }
  }
  return null
}

/** The top-level sqlite_home line (the user's or Orca's), or null when the config has none. */
function findTopLevelSqliteHomeLine(config: string): string | null {
  let scan = createTomlLineScanState()
  for (const line of config.split('\n')) {
    const structural = isTomlStructuralLine(scan)
    scan = updateTomlLineScanState(scan, line)
    if (!structural) {
      continue
    }
    if (getTomlTableHeader(line)) {
      return null
    }
    if (/^\s*(?:sqlite_home|"sqlite_home"|'sqlite_home')\s*=/.test(line)) {
      return line
    }
  }
  return null
}

function hasTopLevelSqliteHome(config: string): boolean {
  return findTopLevelSqliteHomeLine(config) !== null
}

/** Where a home's config puts Codex's databases, from a single-line string value. */
export function readCodexConfiguredSqliteHome(config: string): string | null {
  const line = findTopLevelSqliteHomeLine(config)
  return (line && parseTomlSingleLineStringValue(line, line.indexOf('=') + 1)?.value) || null
}

/** Points Codex's databases at `sqliteHome` unless the user's own config sets one; null removes Orca's line. */
export function applyCodexSharedSqliteHome(config: string, sqliteHome: string | null): string {
  const stripped = stripCodexSharedSqliteHome(config)
  if (sqliteHome === null || hasTopLevelSqliteHome(stripped)) {
    return stripped
  }
  const newline = stripped.includes('\r\n') ? '\r\n' : '\n'
  // Top-level keys must precede every table.
  return `sqlite_home = ${JSON.stringify(sqliteHome)} ${CODEX_SHARED_SQLITE_HOME_MARKER}${newline}${stripped}`
}
