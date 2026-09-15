import { existsSync as realExistsSync, readFileSync as realReadFileSync } from 'node:fs'
import { join } from 'node:path'

export type DiscoveredBrowserCandidate = {
  bundleId: string
  displayName: string
  appPath: string
}

// Narrow fs seams matching exactly how detection uses them — so the real fs functions
// and test fakes both satisfy them without casting through the overloaded fs types.
export type ExistsSync = (path: string) => boolean
export type ReadTextFileSync = (path: string, encoding: BufferEncoding) => string

export type BrowserProfileEntry = { name: string; directory: string }

export type ChromiumProfilesWithCookies = {
  profiles: BrowserProfileEntry[]
  selectedProfile: string
  cookiesPath: string
}

type QueryHttpsHandlers = () => Promise<DiscoveredBrowserCandidate[]>

// Why: default query is an inert stub for isolated unit tests; production always
// injects a real OS query (see detectAllBrowsers → resolveDefaultHttpsHandlersQuery).
const emptyHttpsHandlers: QueryHttpsHandlers = async () => []

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
  existsSync: ExistsSync
): string | null {
  const networkPath = join(profileDir, 'Network', 'Cookies')
  if (existsSync(networkPath)) {
    return networkPath
  }
  const legacyPath = join(profileDir, 'Cookies')
  return existsSync(legacyPath) ? legacyPath : null
}

// Why: Local State profile dirs become path segments; reject traversal/unsafe names.
function isSafeProfileDirectory(directory: string): boolean {
  return (
    directory.length > 0 &&
    directory !== '.' &&
    !directory.includes('\0') &&
    !directory.includes('/') &&
    !directory.includes('\\') &&
    !directory.includes('..')
  )
}

// Enumerate a Chromium data dir's profiles from Local State info_cache (Default-first,
// falling back to a single Default), preserving the picker's multi-profile submenu.
function readChromiumProfiles(
  dataDir: string,
  readFileSync: ReadTextFileSync
): BrowserProfileEntry[] {
  const fallback: BrowserProfileEntry[] = [{ name: 'Default', directory: 'Default' }]
  try {
    const raw = readFileSync(join(dataDir, 'Local State'), 'utf-8')
    const infoCache = (JSON.parse(raw) as { profile?: { info_cache?: unknown } })?.profile
      ?.info_cache
    if (!infoCache || typeof infoCache !== 'object') {
      return fallback
    }
    const profiles: BrowserProfileEntry[] = []
    for (const [dir, info] of Object.entries(infoCache as Record<string, unknown>)) {
      if (!isSafeProfileDirectory(dir)) {
        continue
      }
      profiles.push({ name: (info as { name?: string })?.name ?? dir, directory: dir })
    }
    // Why: keep 'Default' first so the primary profile is preferred as selected.
    profiles.sort((a, b) => Number(b.directory === 'Default') - Number(a.directory === 'Default'))
    return profiles.length > 0 ? profiles : fallback
  } catch {
    return fallback
  }
}

// Resolve a Chromium data dir to its profiles plus the first profile that actually owns
// a cookies DB — so browsers whose usable cookies live in a non-Default profile are still
// detected. Returns null when the dir is not a Chromium store or no profile has cookies.
export function firstChromiumProfileWithCookies(
  dataDir: string,
  deps: { existsSync?: ExistsSync; readFileSync?: ReadTextFileSync } = {}
): ChromiumProfilesWithCookies | null {
  const existsSync = deps.existsSync ?? realExistsSync
  const readFileSync = deps.readFileSync ?? realReadFileSync
  if (!existsSync(join(dataDir, 'Local State'))) {
    return null
  }
  const profiles = readChromiumProfiles(dataDir, readFileSync)
  for (const profile of profiles) {
    const cookiesPath = resolveChromiumCookiesPath(join(dataDir, profile.directory), existsSync)
    if (cookiesPath) {
      return { profiles, selectedProfile: profile.directory, cookiesPath }
    }
  }
  return null
}

// Keep only candidates whose <appSupportRoot>/<displayName> owns a Chromium cookie
// store: a Local State file plus at least one profile with a resolvable cookies DB.
export function filterChromiumCandidates(
  candidates: DiscoveredBrowserCandidate[],
  opts: { appSupportRoot: string; existsSync?: ExistsSync; readFileSync?: ReadTextFileSync }
): DiscoveredBrowserCandidate[] {
  return candidates.filter(
    (candidate) =>
      firstChromiumProfileWithCookies(join(opts.appSupportRoot, candidate.displayName), {
        existsSync: opts.existsSync,
        readFileSync: opts.readFileSync
      }) !== null
  )
}
