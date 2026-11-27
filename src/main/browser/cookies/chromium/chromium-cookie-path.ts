import { existsSync } from 'node:fs'
import { join } from 'node:path'

export function chromiumCookiePaths(profileDir: string): [string, string] {
  return [join(profileDir, 'Network', 'Cookies'), join(profileDir, 'Cookies')]
}

// Chromium 96+ uses Network/Cookies; older profiles keep Cookies at the profile root.
export function resolveChromiumCookiesPath(profileDir: string): string | null {
  const [networkPath, legacyPath] = chromiumCookiePaths(profileDir)
  if (existsSync(networkPath)) {
    return networkPath
  }
  return existsSync(legacyPath) ? legacyPath : null
}
