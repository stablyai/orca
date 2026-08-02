import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Why: Chromium 96+ moved the cookie DB under Network, while older profiles
// still use the profile root. Every reader and replay writer must agree.
export function resolveChromiumCookiesPath(profileDir: string): string | null {
  const networkPath = join(profileDir, 'Network', 'Cookies')
  if (existsSync(networkPath)) {
    return networkPath
  }
  const legacyPath = join(profileDir, 'Cookies')
  return existsSync(legacyPath) ? legacyPath : null
}
