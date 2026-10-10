import { join, win32 as pathWin32 } from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'

// Why: Kimi Code stores managed OAuth tokens through a file token store keyed by
// `oauth/<name>` → `<kimi home>/credentials/<name>.json`. The legacy/default slot
// is `oauth/kimi-code`, but newer CLIs scope the slot per (oauthHost, baseUrl)
// environment (`oauth/kimi-code-env-<hash>`, e.g. for auth.kimi.ai) and record the
// active key in config.toml under `[providers."managed:kimi-code".oauth]`. Once a
// user is on a scoped slot the CLI stops refreshing `kimi-code.json`, so reading
// only the default file shows a permanently expired session.
export const DEFAULT_KIMI_TOKEN_NAME = 'kimi-code'
const OAUTH_KEY_PREFIX = 'oauth/'
const MANAGED_PROVIDER_TABLE = 'providers.managed:kimi-code'
const MANAGED_PROVIDER_OAUTH_TABLE = `${MANAGED_PROVIDER_TABLE}.oauth`

export type KimiCredentialSlot = {
  tokenName: string
  /** API base the token belongs to; null means the CLI's default base URL. */
  baseUrl: string | null
}

function joinKimiPath(kimiHome: string, ...segments: string[]): string {
  // WSL homes arrive as `\\wsl.localhost\<distro>\...`, which only win32 join keeps intact.
  return parseWslUncPath(kimiHome)
    ? pathWin32.join(kimiHome, ...segments)
    : join(kimiHome, ...segments)
}

export function getKimiConfigPath(kimiHome: string): string {
  return joinKimiPath(kimiHome, 'config.toml')
}

export function getKimiCredentialsPath(kimiHome: string, tokenName: string): string {
  return joinKimiPath(kimiHome, 'credentials', `${tokenName}.json`)
}

// Mirrors the CLI's token-name resolution: strip `oauth/`, and refuse anything
// that is not a plain file name so a hand-edited config can't point Orca outside
// the credentials directory.
export function kimiTokenNameFromOAuthKey(key: string): string | null {
  if (!key.startsWith(OAUTH_KEY_PREFIX)) {
    return null
  }
  const name = key.slice(OAUTH_KEY_PREFIX.length)
  if (name.length === 0 || name.startsWith('.') || /[\\/]/.test(name) || name.includes('\0')) {
    return null
  }
  return name
}

function normalizeTableHeader(header: string): string {
  // `[providers."managed:kimi-code".oauth]` and quoting/spacing variants → dotted path.
  return header
    .split('.')
    .map((part) => part.trim().replace(/^(["'])(.*)\1$/, '$2'))
    .join('.')
}

function parseTomlString(raw: string): string | null {
  const match = /^(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:#.*)?$/.exec(raw.trim())
  if (!match) {
    return null
  }
  return match[1] !== undefined ? match[1].replace(/\\(["\\])/g, '$1') : (match[2] ?? null)
}

function readTomlTableString(configToml: string, table: string, key: string): string | null {
  let inTable = false
  const pairPattern = new RegExp(`^${key}\\s*=\\s*(.+)$`)
  for (const rawLine of configToml.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('[')) {
      const header = /^\[([^[\]]+)\]\s*(?:#.*)?$/.exec(line)
      inTable = header !== null && normalizeTableHeader(header[1]) === table
      continue
    }
    if (!inTable) {
      continue
    }
    const pair = pairPattern.exec(line)
    if (pair) {
      return parseTomlString(pair[1])
    }
  }
  return null
}

/**
 * Read the managed Kimi Code OAuth key from config.toml without a TOML
 * dependency: only single-line strings the CLI itself writes are needed.
 */
export function parseKimiManagedOAuthKey(configToml: string): string | null {
  return readTomlTableString(configToml, MANAGED_PROVIDER_OAUTH_TABLE, 'key')
}

/**
 * The managed provider's `base_url`, i.e. the API host the scoped token was
 * issued for. Only absolute https URLs without embedded credentials are
 * accepted so a malformed config can't redirect the bearer token elsewhere.
 */
export function parseKimiManagedBaseUrl(configToml: string): string | null {
  const raw = readTomlTableString(configToml, MANAGED_PROVIDER_TABLE, 'base_url')
  if (!raw) {
    return null
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    return null
  }
  return raw.replace(/\/+$/, '')
}

/**
 * Credential slots to try, configured slot first, always falling back to the
 * default slot. The scoped slot carries its environment's base URL so the token
 * is only sent to the host it belongs to (the CLI does the same); the default
 * slot always uses the default base URL.
 */
export function resolveKimiCredentialSlots(configToml: string | null): KimiCredentialSlot[] {
  const defaultSlot: KimiCredentialSlot = { tokenName: DEFAULT_KIMI_TOKEN_NAME, baseUrl: null }
  if (!configToml) {
    return [defaultSlot]
  }
  const key = parseKimiManagedOAuthKey(configToml)
  const configured = key ? kimiTokenNameFromOAuthKey(key) : null
  if (!configured || configured === DEFAULT_KIMI_TOKEN_NAME) {
    return [defaultSlot]
  }
  return [{ tokenName: configured, baseUrl: parseKimiManagedBaseUrl(configToml) }, defaultSlot]
}
