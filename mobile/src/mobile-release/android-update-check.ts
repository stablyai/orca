import AsyncStorage from '@react-native-async-storage/async-storage'

// Why: Android APKs are published as GitHub pre-releases, which /releases/latest hides.
export const ANDROID_RELEASES_API_URL =
  'https://api.github.com/repos/stablyai/orca/releases?per_page=30'
export const ANDROID_RELEASES_PAGE_URL =
  'https://github.com/stablyai/orca/releases?q=mobile-android-v'
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

const STATE_KEY = 'orca:androidUpdate'
const TAG_PREFIX = 'mobile-android-v'
const APK_ASSET_NAME = 'app-release.apk'

export type AndroidUpdate = {
  readonly version: string
  readonly apkUrl: string
}

type StoredState = {
  // Why: null = never fetched, so a skip recorded before the first check does not defer it.
  readonly checkedAt: number | null
  readonly latest: AndroidUpdate | null
  readonly skippedVersion: string | null
}

export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] || 0) - (right[i] || 0)
    if (diff !== 0) {
      return diff
    }
  }
  return 0
}

export function findLatestAndroidRelease(releases: unknown): AndroidUpdate | null {
  if (!Array.isArray(releases)) {
    return null
  }
  let latest: AndroidUpdate | null = null
  for (const entry of releases as Array<Record<string, unknown> | null>) {
    const tag = entry?.tag_name
    if (typeof tag !== 'string' || !tag.startsWith(TAG_PREFIX) || entry?.draft === true) {
      continue
    }
    const assets = Array.isArray(entry?.assets)
      ? (entry.assets as Array<Record<string, unknown>>)
      : []
    const apkUrl = assets.find((asset) => asset?.name === APK_ASSET_NAME)?.browser_download_url
    if (typeof apkUrl !== 'string') {
      continue
    }
    const version = tag.slice(TAG_PREFIX.length)
    if (!latest || compareVersions(version, latest.version) > 0) {
      latest = { version, apkUrl }
    }
  }
  return latest
}

export async function fetchLatestAndroidRelease(
  fetchFn: typeof fetch = fetch
): Promise<AndroidUpdate | null> {
  const response = await fetchFn(ANDROID_RELEASES_API_URL, {
    headers: { Accept: 'application/vnd.github+json' }
  })
  if (!response.ok) {
    throw new Error(`GitHub releases request failed: ${response.status}`)
  }
  return findLatestAndroidRelease(await response.json())
}

async function loadState(): Promise<StoredState | null> {
  try {
    const raw = await AsyncStorage.getItem(STATE_KEY)
    return raw ? (JSON.parse(raw) as StoredState) : null
  } catch {
    return null
  }
}

async function saveState(state: StoredState): Promise<void> {
  try {
    await AsyncStorage.setItem(STATE_KEY, JSON.stringify(state))
  } catch {
    // Why: storage failure only costs an extra check next time.
  }
}

function isCheckDue(state: StoredState | null, now: number): boolean {
  if (state?.checkedAt == null) {
    return true
  }
  // Why: a clock set backwards would otherwise silence checks for days.
  return now < state.checkedAt || now - state.checkedAt >= CHECK_INTERVAL_MS
}

export async function checkForAndroidUpdate(opts: {
  currentVersion: string
  now?: number
  fetchFn?: typeof fetch
}): Promise<AndroidUpdate | null> {
  const now = opts.now ?? Date.now()
  const stored = await loadState()
  let state = stored
  if (isCheckDue(stored, now)) {
    try {
      const latest = await fetchLatestAndroidRelease(opts.fetchFn)
      state = { checkedAt: now, latest, skippedVersion: stored?.skippedVersion ?? null }
      await saveState(state)
    } catch {
      // Why: keep the stale checkedAt so the next foreground retries instead of waiting a day.
    }
  }
  const latest = state?.latest
  if (!latest || compareVersions(latest.version, opts.currentVersion) <= 0) {
    return null
  }
  return latest.version === state?.skippedVersion ? null : latest
}

export async function skipAndroidUpdate(version: string): Promise<void> {
  const stored = await loadState()
  await saveState({
    checkedAt: stored?.checkedAt ?? null,
    latest: stored?.latest ?? null,
    skippedVersion: version
  })
}
