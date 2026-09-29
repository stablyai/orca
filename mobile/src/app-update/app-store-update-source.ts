import type { AppUpdateCheckResult, AppUpdateSource } from './app-update-source'
import { isNewerReleaseVersion } from './app-update-source'

const LOOKUP_URL = 'https://itunes.apple.com/lookup?bundleId=com.stably.orca.mobile'

type Fetch = typeof fetch

/**
 * The store listing's version and page. TestFlight installs have no receipt signal without a new
 * dependency; they stay quiet because their build is at or ahead of the store's version.
 */
export function parseAppStoreLookup(reply: unknown): { version: string; url: string } | null {
  const results: unknown =
    typeof reply === 'object' && reply !== null ? Reflect.get(reply, 'results') : null
  const first: unknown = Array.isArray(results) ? results[0] : null
  if (typeof first !== 'object' || first === null) {
    return null
  }
  const version: unknown = Reflect.get(first, 'version')
  const trackId: unknown = Reflect.get(first, 'trackId')
  return typeof version === 'string' && typeof trackId === 'number'
    ? { version, url: `https://apps.apple.com/app/id${trackId}` }
    : null
}

export function createAppStoreUpdateSource(fetchImpl: Fetch): AppUpdateSource {
  return {
    async check(installedVersion, signal): Promise<AppUpdateCheckResult> {
      const reply = await fetchImpl(LOOKUP_URL, { signal })
      if (!reply.ok) {
        throw new Error(`App Store lookup HTTP ${reply.status}`)
      }
      const listing = parseAppStoreLookup(await reply.json())
      return listing && isNewerReleaseVersion(listing.version, installedVersion)
        ? { kind: 'available', version: listing.version, url: listing.url }
        : { kind: 'current' }
    }
  }
}

export const appStoreUpdateSource = createAppStoreUpdateSource((input, init) => fetch(input, init))
