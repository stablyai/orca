import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
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

function hasTopLevelSqliteHome(config: string): boolean {
  let scan = createTomlLineScanState()
  for (const line of config.split('\n')) {
    const structural = isTomlStructuralLine(scan)
    scan = updateTomlLineScanState(scan, line)
    if (!structural) {
      continue
    }
    if (getTomlTableHeader(line)) {
      return false
    }
    if (/^\s*(?:sqlite_home|"sqlite_home"|'sqlite_home')\s*=/.test(line)) {
      return true
    }
  }
  return false
}

/**
 * Points Codex's databases at `sqliteHome` unless the user's own config already sets one;
 * null removes Orca's line and undefined leaves the config as it is.
 */
export function applyCodexSharedSqliteHome(
  config: string,
  sqliteHome: string | null | undefined
): string {
  if (sqliteHome === undefined) {
    return config
  }
  const stripped = stripCodexSharedSqliteHome(config)
  if (sqliteHome === null || hasTopLevelSqliteHome(stripped)) {
    return stripped
  }
  const newline = stripped.includes('\r\n') ? '\r\n' : '\n'
  // Top-level keys must precede every table.
  return `sqlite_home = ${JSON.stringify(sqliteHome)} ${CODEX_SHARED_SQLITE_HOME_MARKER}${newline}${stripped}`
}
