import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Chromium 96+ uses Network/Cookies; older profiles keep Cookies at the profile root.
export function resolveChromiumCookiesPath(profileDir: string): string | null {
  const networkPath = join(profileDir, 'Network', 'Cookies')
  if (existsSync(networkPath)) {
    return networkPath
  }
  const legacyPath = join(profileDir, 'Cookies')
  return existsSync(legacyPath) ? legacyPath : null
}
