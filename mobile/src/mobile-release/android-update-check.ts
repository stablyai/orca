import AsyncStorage from '@react-native-async-storage/async-storage'
import { compareAppVersions } from '../../../src/shared/app-version'

// Why: Android APKs are published as GitHub pre-releases, which /releases/latest hides.
export const ANDROID_RELEASES_API_URL =
  'https://api.github.com/repos/stablyai/orca/releases?per_page=100'
export const ANDROID_RELEASES_PAGE_URL =
  'https://github.com/stablyai/orca/releases?q=mobile-android-v'
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
// Why: desktop releases dominate the feed (roughly daily), so the newest Android release can
// sit past page one. 5 × 100 releases covers about a year of desktop cadence.
export const MAX_RELEASE_PAGES = 5
export const REQUEST_TIMEOUT_MS = 15_000

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
      ? (entry.assets as Array<Record<string, unknown> | null>)
      : []
    if (!assets.some((asset) => asset?.name === APK_ASSET_NAME)) {
      continue
    }
    const version = tag.slice(TAG_PREFIX.length)
    if (!latest || compareAppVersions(version, latest.version) > 0) {
      // Why: build the URL from the tag so release metadata cannot redirect the download.
      latest = {
        version,
        apkUrl: `https://github.com/stablyai/orca/releases/download/${tag}/${APK_ASSET_NAME}`
      }
    }
  }
  return latest
}

function nextPageUrl(response: Response): string | null {
  const link = response.headers?.get('link') ?? ''
  return link.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null
}

export async function fetchLatestAndroidRelease(
  fetchFn: typeof fetch = fetch
): Promise<AndroidUpdate | null> {
  // Why: React Native fetch has no default deadline; one budget covers every page so a stall
  // cannot pin the shared request until the app restarts.
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    let url: string | null = ANDROID_RELEASES_API_URL
    for (let page = 0; page < MAX_RELEASE_PAGES && url; page++) {
      const response = await fetchFn(url, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: controller.signal
      })
      if (!response.ok) {
        throw new Error(`GitHub releases request failed: ${response.status}`)
      }
      // Why: releases are newest-first, so the first page holding any Android release holds the newest.
      const latest = findLatestAndroidRelease(await response.json())
      if (latest) {
        return latest
      }
      url = nextPageUrl(response)
    }
    return null
  } finally {
    clearTimeout(deadline)
  }
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

// Why: read-modify-write sections are serialized so a skip and a check result cannot clobber each other.
let stateQueue: Promise<unknown> = Promise.resolve()
function withStateLock<T>(task: () => Promise<T>): Promise<T> {
  const run = stateQueue.then(task)
  stateQueue = run.catch(() => {})
  return run
}

// Why: a mount check and an AppState "active" check can overlap; they must not each walk the pages.
let inFlightRelease: Promise<AndroidUpdate | null | undefined> | null = null
function fetchLatestAndroidReleaseShared(fetchFn?: typeof fetch) {
  inFlightRelease ??= fetchLatestAndroidRelease(fetchFn)
    .catch(() => undefined)
    .finally(() => {
      inFlightRelease = null
    })
  return inFlightRelease
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
  if (isCheckDue(await loadState(), now)) {
    // Why: the request has no deadline, so it runs outside the lock; a skip must not wait on it.
    // A failed request leaves checkedAt stale so the next foreground retries instead of waiting a day.
    const latest = await fetchLatestAndroidReleaseShared(opts.fetchFn)
    if (latest !== undefined) {
      await withStateLock(async () => {
        const fresh = await loadState()
        await saveState({ checkedAt: now, latest, skippedVersion: fresh?.skippedVersion ?? null })
      })
    }
  }
  const state = await loadState()
  const latest = state?.latest
  if (!latest || compareAppVersions(latest.version, opts.currentVersion) <= 0) {
    return null
  }
  return latest.version === state.skippedVersion ? null : latest
}

export function skipAndroidUpdate(version: string): Promise<void> {
  return withStateLock(async () => {
    const stored = await loadState()
    await saveState({
      checkedAt: stored?.checkedAt ?? null,
      latest: stored?.latest ?? null,
      skippedVersion: version
    })
  })
}
