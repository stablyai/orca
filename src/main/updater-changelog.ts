import { net } from 'electron'
import type { ChangelogData } from '../shared/types'
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

/** Returns true when the entry has showcase media (gif/screenshot) worth demoing. */
function hasRichContent(entry: ChangelogEntry): boolean {
  return Boolean(entry.mediaUrl)
}

/**
 * Fetches the remote changelog and finds the best entry to show the user.
 *
 * 1. If the incoming version has an exact match with rich content, use it.
 * 2. Otherwise, find the most recent entry that has rich content. If the user's
 *    local version is behind that entry, show it anyway — demoing an older
 *    highlight is better than showing nothing. In this fallback case the
 *    release notes link points to the generic changelog page instead of a
 *    version-specific URL.
 *
 * Why net.fetch instead of fetch: Electron's `net` module respects the app's
 * proxy/certificate settings and has no CORS restrictions.
 */
export async function fetchChangelog(
  incomingVersion: string,
  localVersion: string
): Promise<ChangelogData | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)

  try {
    const res = await net.fetch('https://onorca.dev/whats-new/changelog.json', {
      signal: controller.signal
    })
    if (!res.ok) {
      return null
    }
    const json: unknown = await res.json()

    // Why: the JSON endpoint is external and could serve malformed data.
    // Validate the shape before indexing into it to avoid runtime errors
    // that would propagate up and delay the 'available' status broadcast.
    if (!Array.isArray(json)) {
      return null
    }
    const entries = json as ChangelogEntry[]

    const localIndex = entries.findIndex((e) => e.version === localVersion)

    // ── Try exact match first ────────────────────────────────────────
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

    // ── Fallback: find the most recent entry with rich content ────────
    // Why: releases often ship without rich media/description. Rather than
    // showing the plain card, we look for the latest entry that does have
    // rich content. As long as the user's local version is behind that
    // entry, the demo is still relevant — it highlights something they
    // haven't seen yet. We swap the release notes URL to the generic
    // changelog page since the shown content doesn't match the incoming
    // version.
    for (let i = 0; i < entries.length; i++) {
      const candidate = entries[i]
      if (!isValidEntry(candidate) || !hasRichContent(candidate)) {
        continue
      }

      // Only show this entry if the user's local version is at or behind it.
      // Why: the user hasn't necessarily seen the rich card for their own
      // version (e.g., they updated silently or dismissed the card), so
      // entries at the same version as localVersion are still worth showing.
      // When localIndex === -1 the local version isn't in the JSON at all —
      // this could mean it's very old OR very new (e.g., a patch release not
      // yet in the changelog). Fall back to semver comparison to avoid
      // showing stale content to users who are already ahead.
      if (localIndex !== -1) {
        if (localIndex < i) {
          continue
        }
      } else if (compareVersions(localVersion, candidate.version) >= 0) {
        // localVersion is newer than (or same as) this candidate — user already
        // passed it. Why >=: compareVersions returns 0 both for genuinely equal
        // versions and for unparseable strings. In the localIndex === -1 path,
        // equal means localVersion literally matches the candidate but wasn't
        // found by findIndex (shouldn't happen), and unparseable means we can't
        // determine the relationship. Either way, skipping is the safe default
        // to avoid showing stale content.
        continue
      }

      // Why: releasesBehind counts how far behind the user is from the
      // incoming update, not from the shown content entry. When incomingIndex
      // is -1, the incoming version is newer than anything in the JSON —
      // treat it as being at the front (index 0) for counting purposes.
      const effectiveIncomingIndex = incomingIndex !== -1 ? incomingIndex : 0
      const releasesBehind =
        localIndex === -1
          ? null
          : localIndex - effectiveIncomingIndex > 0
            ? localIndex - effectiveIncomingIndex
            : null
      const { version: _, ...release } = candidate
      // Why: the shown content is from an older entry, not the incoming version.
      // Point to the generic changelog page so the link doesn't mislead.
      return { release: { ...release, releaseNotesUrl: CHANGELOG_URL }, releasesBehind }
    }

    return null
  } finally {
    clearTimeout(timeout)
  }
}
