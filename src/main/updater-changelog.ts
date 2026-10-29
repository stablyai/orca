import { net } from 'electron'
import type { ChangelogData } from '../shared/update-status-types'
import { compareVersions } from './updater-fallback'

type ChangelogEntry = {
  version: string
  title: string
  description: string
  mediaUrl?: string
  releaseNotesUrl: string
}

const CHANGELOG_URL = 'https://onorca.dev/changelog'

function isValidEntry(entry: ChangelogEntry): boolean {
  return (
    typeof entry.title === 'string' &&
    typeof entry.description === 'string' &&
    typeof entry.releaseNotesUrl === 'string'
  )
}

function hasRichContent(entry: ChangelogEntry): boolean {
  return Boolean(entry.mediaUrl)
}

// Electron net.fetch honors app proxy/certificate settings and avoids renderer CORS.
export async function fetchChangelog(
  incomingVersion: string,
  localVersion: string
): Promise<ChangelogData | null> {
  const res = await net.fetch('https://onorca.dev/whats-new/changelog.json', {
    signal: AbortSignal.timeout(5000)
  })
  if (!res.ok) {
    return null
  }
  const json: unknown = await res.json()

  if (!Array.isArray(json)) {
    return null
  }
  const entries = json as ChangelogEntry[]

  const localIndex = entries.findIndex((e) => e.version === localVersion)

  const incomingIndex = entries.findIndex((e) => e.version === incomingVersion)
  if (incomingIndex !== -1) {
    const entry = entries[incomingIndex]
    if (isValidEntry(entry) && hasRichContent(entry)) {
      const releasesBehind =
        localIndex === -1
          ? null
          : localIndex - incomingIndex > 0
            ? localIndex - incomingIndex
            : null
      const { version: _, ...release } = entry
      return { release, releasesBehind }
    }
  }

  // Releases without media reuse a recent highlight the user may not have seen.
  for (let i = 0; i < entries.length; i++) {
    const candidate = entries[i]
    if (!isValidEntry(candidate) || !hasRichContent(candidate)) {
      continue
    }

    // Users may have missed their current version's card; reject only older highlights.
    if (localIndex !== -1) {
      if (localIndex < i) {
        continue
      }
    } else if (compareVersions(localVersion, candidate.version) >= 0) {
      // compareVersions also returns zero for unparseable versions; skip uncertain matches.
      continue
    }

    // Count from the incoming update, not the displayed highlight; an unlisted incoming tag starts at zero.
    const effectiveIncomingIndex = incomingIndex !== -1 ? incomingIndex : 0
    const releasesBehind =
      localIndex === -1
        ? null
        : localIndex - effectiveIncomingIndex > 0
          ? localIndex - effectiveIncomingIndex
          : null
    const { version: _, ...release } = candidate
    // Fallback content may not match the incoming version; link to the full changelog.
    return { release: { ...release, releaseNotesUrl: CHANGELOG_URL }, releasesBehind }
  }

  return null
}
