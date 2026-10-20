import { readFileSync } from 'node:fs'
import { join, posix as pathPosix, win32 as pathWin32 } from 'node:path'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  parseTomlSingleLineStringValue,
  updateTomlLineScanState
} from './config-toml-line-scan'

export const CODEX_SQLITE_HOME_ENV = 'CODEX_SQLITE_HOME'

/** The top-level `sqlite_home` in a Codex config.toml, resolved against its directory. */
export function readConfiguredCodexSqliteHome(config: string, configDir: string): string | null {
  let scanState = createTomlLineScanState()
  for (const line of config.split('\n')) {
    if (isTomlStructuralLine(scanState)) {
      if (getTomlTableHeader(line)) {
        // Top-level keys end at the first table.
        return null
      }
      const equalsIndex = line.indexOf('=')
      if (equalsIndex !== -1 && line.slice(0, equalsIndex).trim() === 'sqlite_home') {
        const parsed = parseTomlSingleLineStringValue(line, equalsIndex + 1)
        const value = parsed?.value.trim()
        if (!value) {
          return null
        }
        const path = configDir.startsWith('/') ? pathPosix : pathWin32
        return path.isAbsolute(value) ? value : path.join(configDir, value)
      }
    }
    scanState = updateTomlLineScanState(scanState, line)
  }
  return null
}

/**
 * Where a Codex home keeps its state databases, in Codex's precedence:
 * config.toml, then the environment, then the home itself
 * (codex-rs core/src/config/mod.rs). Managed requirements files are not read.
 */
export function resolveEffectiveCodexSqliteHome(
  codexHome: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  let config: string | null = null
  try {
    config = readFileSync(join(codexHome, 'config.toml'), 'utf8')
  } catch {
    config = null
  }
  const configured = config ? readConfiguredCodexSqliteHome(config, codexHome) : null
  if (configured) {
    return configured
  }
  const fromEnv = env[CODEX_SQLITE_HOME_ENV]?.trim()
  // Why: Codex resolves a relative env value against each session's cwd, which no reader knows.
  return fromEnv && (pathPosix.isAbsolute(fromEnv) || pathWin32.isAbsolute(fromEnv))
    ? fromEnv
    : codexHome
}
