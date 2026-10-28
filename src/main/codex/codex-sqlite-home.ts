import { readFileSync } from 'node:fs'
import { join, posix as pathPosix, win32 as pathWin32 } from 'node:path'
import { parse as parseToml } from 'smol-toml'

export const CODEX_SQLITE_HOME_ENV = 'CODEX_SQLITE_HOME'

/** The top-level `sqlite_home` in a Codex config.toml, resolved against its directory. */
export function readConfiguredCodexSqliteHome(config: string, configDir: string): string | null {
  try {
    const value = parseToml(config).sqlite_home
    if (typeof value === 'string' && value.length > 0) {
      const path = configDir.startsWith('/') ? pathPosix : pathWin32
      return path.isAbsolute(value) ? value : path.join(configDir, value)
    }
  } catch {
    return null
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
