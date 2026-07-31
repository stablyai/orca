// Why: Android ships as a sideloaded APK on GitHub Releases (see
// .github/workflows/mobile-android-release.yml), so no store ever tells the
// user a newer build exists. This module is the only source of truth for
// "what is the newest Android release".

// Why: not /releases. Desktop publishes hourly releases and the Android lane
// publishes with `--prerelease --latest=false`, so /releases/latest points at a
// desktop build and a /releases page can hold zero Android entries (measured
// 2026-08-01: newest Android release sat at index 9, with gaps of 37 between
// Android entries). This ref endpoint filters by tag prefix server-side, so one
// request returns every Android release and nothing else (16 at that time).
const MATCHING_REFS_URL =
  'https://api.github.com/repos/stablyai/orca/git/matching-refs/tags/mobile-android-v'
const RELEASE_PAGE_BASE = 'https://github.com/stablyai/orca/releases/tag/'
const TAG_REF_PREFIX = 'refs/tags/'
const ANDROID_TAG_PREFIX = 'mobile-android-v'
const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/
const REFS_PAGE_SIZE = 100
// Tripwire: refs come back oldest-first, so the newest tag is on the last page.
// 16 Android tags existed after ~9 months of releases; 10 pages covers 1000.
const MAX_REFS_PAGES = 10

export type AndroidRelease = {
  version: string
  tag: string
  url: string
}

export function parseAndroidReleaseTag(tag: string): string | null {
  const bare = tag.startsWith(TAG_REF_PREFIX) ? tag.slice(TAG_REF_PREFIX.length) : tag
  if (!bare.startsWith(ANDROID_TAG_PREFIX)) {
    return null
  }
  const version = bare.slice(ANDROID_TAG_PREFIX.length)
  return SEMVER_PATTERN.test(version) ? version : null
}

// Negative when a < b, positive when a > b, 0 when equal.
export function compareVersions(a: string, b: string): number {
  const left = SEMVER_PATTERN.exec(a)
  const right = SEMVER_PATTERN.exec(b)
  if (!left || !right) {
    return 0
  }
  for (let part = 1; part <= 3; part++) {
    const diff = Number(left[part]) - Number(right[part])
    if (diff !== 0) {
      return diff
    }
  }
  return 0
}

export function selectLatestAndroidRelease(payload: unknown): AndroidRelease | null {
  if (!Array.isArray(payload)) {
    return null
  }
  let latest: AndroidRelease | null = null
  for (const entry of payload) {
    const ref = (entry as { ref?: unknown })?.ref
    if (typeof ref !== 'string') {
      continue
    }
    const version = parseAndroidReleaseTag(ref)
    if (!version) {
      continue
    }
    if (!latest || compareVersions(version, latest.version) > 0) {
      const tag = ref.slice(TAG_REF_PREFIX.length)
      latest = { version, tag, url: `${RELEASE_PAGE_BASE}${tag}` }
    }
  }
  return latest
}

// Why: an update check is never worth a hang or a crash — every failure
// (offline, rate limited, malformed body) resolves to null and stays silent.
export async function fetchLatestAndroidRelease(options?: {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<AndroidRelease | null> {
  const fetchImpl = options?.fetchImpl ?? fetch
  const timeoutMs = options?.timeoutMs ?? 5000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let latest: AndroidRelease | null = null
    for (let page = 1; page <= MAX_REFS_PAGES; page++) {
      const response = await fetchImpl(
        `${MATCHING_REFS_URL}?per_page=${REFS_PAGE_SIZE}&page=${page}`,
        {
          signal: controller.signal,
          headers: { Accept: 'application/vnd.github+json' }
        }
      )
      if (!response.ok) {
        return latest
      }
      const payload: unknown = await response.json()
      const pageLatest = selectLatestAndroidRelease(payload)
      if (pageLatest && (!latest || compareVersions(pageLatest.version, latest.version) > 0)) {
        latest = pageLatest
      }
      if (!Array.isArray(payload) || payload.length < REFS_PAGE_SIZE) {
        return latest
      }
    }
    return latest
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
