import AsyncStorage from '@react-native-async-storage/async-storage'

const PINS_PREFIX = 'orca:pins:'
const PREFS_PREFIX = 'orca:prefs:'
const NOTIF_KEY = 'orca:pushNotificationsEnabled'

// Why: default-off so the iOS notification permission prompt never
// fires until the user explicitly opts in via Settings → Notifications.
// Apple's review guideline 4.5.4 and HIG both prefer user-initiated
// permission prompts; default-on would fire the prompt the moment the
// desktop sent its first notification, which can read as unsolicited.
export async function loadPushNotificationsEnabled(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(NOTIF_KEY)
    if (raw === null) return false
    return raw === 'true'
  } catch {
    return false
  }
}

export async function savePushNotificationsEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(NOTIF_KEY, String(enabled))
}

export type HostPreferences = {
  sortMode: string
  filterMode: string
  groupMode: string
  collapsedGroups: string[]
  selectedRepos: string[]
}

const DEFAULT_PREFS: HostPreferences = {
  sortMode: 'smart',
  filterMode: 'all',
  groupMode: 'none',
  collapsedGroups: [],
  selectedRepos: []
}
const SORT_MODES = new Set(['smart', 'recent', 'name'])
const FILTER_MODES = new Set(['all', 'active'])
const GROUP_MODES = new Set(['none', 'repo', 'prStatus'])

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function allowedString(value: unknown, allowed: Set<string>, fallback: string): string {
  return typeof value === 'string' && allowed.has(value) ? value : fallback
}

export async function loadPinnedIds(hostId: string): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(PINS_PREFIX + hostId)
    if (!raw) return new Set()
    return new Set(stringArray(JSON.parse(raw)))
  } catch {
    return new Set()
  }
}

export async function savePinnedIds(hostId: string, ids: Set<string>): Promise<void> {
  await AsyncStorage.setItem(PINS_PREFIX + hostId, JSON.stringify([...ids]))
}

export async function loadPreferences(hostId: string): Promise<HostPreferences> {
  try {
    const raw = await AsyncStorage.getItem(PREFS_PREFIX + hostId)
    if (!raw) return DEFAULT_PREFS
    const parsed = JSON.parse(raw) as Partial<HostPreferences>
    return {
      sortMode: allowedString(parsed.sortMode, SORT_MODES, DEFAULT_PREFS.sortMode),
      filterMode: allowedString(parsed.filterMode, FILTER_MODES, DEFAULT_PREFS.filterMode),
      groupMode: allowedString(parsed.groupMode, GROUP_MODES, DEFAULT_PREFS.groupMode),
      collapsedGroups: stringArray(parsed.collapsedGroups),
      selectedRepos: stringArray(parsed.selectedRepos)
    }
  } catch {
    return DEFAULT_PREFS
  }
}

export async function savePreferences(
  hostId: string,
  prefs: Partial<HostPreferences>
): Promise<void> {
  const current = await loadPreferences(hostId)
  const merged = { ...current, ...prefs }
  await AsyncStorage.setItem(PREFS_PREFIX + hostId, JSON.stringify(merged))
}
