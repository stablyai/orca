import { join, win32 as pathWin32 } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { parseWslUncPath } from '../../shared/wsl-paths'

// The CLI's default shared environment persists its token in the
// `kimi-code` slot; Kimi Code 2.x scoped environments (for example
// `auth.kimi.ai` / `api.kimi.ai`, the default for the `mainland-cn` region)
// persist under `kimi-code-env-<hash>` slots instead (#24176).
export const DEFAULT_KIMI_OAUTH_SLOT = 'kimi-code'

function joinKimiPath(kimiHome: string, ...segments: string[]): string {
  // WSL homes arrive as `\\wsl.localhost\<distro>\...`, which only win32 join keeps intact.
  return parseWslUncPath(kimiHome)
    ? pathWin32.join(kimiHome, ...segments)
    : join(kimiHome, ...segments)
}

export function getKimiConfigPath(kimiHome: string): string {
  return joinKimiPath(kimiHome, 'config.toml')
}

export function getKimiCredentialsPath(kimiHome: string, slot: string): string {
  return joinKimiPath(kimiHome, 'credentials', `${slot}.json`)
}

// Mirrors the CLI's `resolveKimiCodeOAuthKey` slot naming: the active key is
// `oauth/<slot name>`, stored in config.toml as
// [providers."managed:kimi-code".oauth].key. The charset excludes separators so
// a crafted key can never escape the credentials directory.
const OAUTH_KEY_PATTERN = /^oauth\/([A-Za-z0-9._-]+)$/

/**
 * Parse the active OAuth slot out of a config.toml body. Returns null when the
 * text is malformed or names no usable key; callers must treat null as "keep
 * the historical default" so users of the shared default environment
 * (auth.kimi.com) are unaffected.
 */
export function parseKimiActiveOAuthSlot(configText: string): string | null {
  let parsed: unknown
  try {
    parsed = parseToml(configText)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  if (!('providers' in parsed)) {
    return null
  }
  const providers: unknown = parsed.providers
  if (typeof providers !== 'object' || providers === null) {
    return null
  }
  if (!('managed:kimi-code' in providers)) {
    return null
  }
  const managed: unknown = providers['managed:kimi-code']
  if (typeof managed !== 'object' || managed === null || !('oauth' in managed)) {
    return null
  }
  const oauth: unknown = managed.oauth
  if (typeof oauth !== 'object' || oauth === null || !('key' in oauth)) {
    return null
  }
  const key: unknown = oauth.key
  if (typeof key !== 'string') {
    return null
  }
  const match = OAUTH_KEY_PATTERN.exec(key)
  return match ? match[1] : null
}
