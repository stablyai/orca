import AsyncStorage from '@react-native-async-storage/async-storage'

const LAST_CHECKED_AT_KEY = 'orca:appUpdate:lastCheckedAt'
const LATEST_KEY = 'orca:appUpdate:latest'
const DISMISSED_VERSION_KEY = 'orca:appUpdate:dismissedVersion'

export type KnownAppUpdate = { readonly version: string; readonly url: string }

export type AppUpdatePreferences = {
  /** Last successful check; failures never move it. */
  readonly lastCheckedAt: number | null
  /** Newest installable release that check saw, or null when it saw none. */
  readonly latest: KnownAppUpdate | null
  readonly dismissedVersion: string | null
}

export const EMPTY_APP_UPDATE_PREFERENCES: AppUpdatePreferences = {
  lastCheckedAt: null,
  latest: null,
  dismissedVersion: null
}

function parseLatest(raw: string | null): KnownAppUpdate | null {
  if (!raw) {
    return null
  }
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  const version: unknown = Reflect.get(parsed, 'version')
  const url: unknown = Reflect.get(parsed, 'url')
  return typeof version === 'string' && typeof url === 'string' ? { version, url } : null
}

export async function loadAppUpdatePreferences(): Promise<AppUpdatePreferences> {
  try {
    const [[, checkedAt], [, latest], [, dismissed]] = await AsyncStorage.multiGet([
      LAST_CHECKED_AT_KEY,
      LATEST_KEY,
      DISMISSED_VERSION_KEY
    ])
    const lastCheckedAt = checkedAt === null ? null : Number(checkedAt)
    return {
      lastCheckedAt:
        lastCheckedAt !== null && Number.isFinite(lastCheckedAt) ? lastCheckedAt : null,
      latest: parseLatest(latest),
      dismissedVersion: dismissed
    }
  } catch {
    return EMPTY_APP_UPDATE_PREFERENCES
  }
}

export async function saveAppUpdateCheck(checkedAt: number, latest: KnownAppUpdate | null) {
  await AsyncStorage.multiSet([
    [LAST_CHECKED_AT_KEY, String(checkedAt)],
    [LATEST_KEY, latest ? JSON.stringify(latest) : '']
  ])
}

export async function saveDismissedAppUpdateVersion(version: string): Promise<void> {
  await AsyncStorage.setItem(DISMISSED_VERSION_KEY, version)
}
