import { existsSync as realExistsSync } from 'node:fs'
import { join } from 'node:path'

export type DiscoveredBrowserCandidate = {
  bundleId: string
  displayName: string
  appPath: string
}

type QueryHttpsHandlers = () => Promise<DiscoveredBrowserCandidate[]>

// Why: the real OS URL-handler query is platform-native and deferred; default to
// an inert stub so Phase 0 stays fully unit-testable with no OS access.
const emptyHttpsHandlers: QueryHttpsHandlers = async () => {
  // TODO: real OS URL-handler query (deferred)
  return []
}

export async function discoverInstalledBrowsers(opts: {
  platform: NodeJS.Platform
  queryHttpsHandlers?: QueryHttpsHandlers
}): Promise<DiscoveredBrowserCandidate[]> {
  const query = opts.queryHttpsHandlers ?? emptyHttpsHandlers
  return query()
}

// Why: mirror resolveChromiumCookiesPath — Chromium 96+ moved the cookie DB under
// Network, older profiles keep it at the profile root. Injected existsSync keeps it testable.
export function resolveChromiumCookiesPath(
  profileDir: string,
  existsSync: typeof realExistsSync
): string | null {
  const networkPath = join(profileDir, 'Network', 'Cookies')
  if (existsSync(networkPath)) {
    return networkPath
  }
  const legacyPath = join(profileDir, 'Cookies')
  return existsSync(legacyPath) ? legacyPath : null
}

// Keep only candidates whose <appSupportRoot>/<displayName> owns a Chromium cookie
// store: a Local State file plus a resolvable Default-profile cookies DB.
export function filterChromiumCandidates(
  candidates: DiscoveredBrowserCandidate[],
  opts: { appSupportRoot: string; existsSync?: typeof realExistsSync }
): DiscoveredBrowserCandidate[] {
  const existsSync = opts.existsSync ?? realExistsSync
  return candidates.filter((candidate) => {
    const dataDir = join(opts.appSupportRoot, candidate.displayName)
    if (!existsSync(join(dataDir, 'Local State'))) {
      return false
    }
    return resolveChromiumCookiesPath(join(dataDir, 'Default'), existsSync) !== null
  })
}
