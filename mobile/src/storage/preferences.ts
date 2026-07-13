import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  DEFAULT_VISIBLE_USAGE_PROVIDERS,
  USAGE_PROVIDER_IDS,
  type UsageProviderKey
} from '../components/account-usage-state'

const PINS_PREFIX = 'orca:pins:'
const NOTIF_KEY = 'orca:pushNotificationsEnabled'

// Why: default-off so the iOS notification permission prompt never
// fires until the user explicitly opts in via Settings → Notifications.
// Apple's review guideline 4.5.4 and HIG both prefer user-initiated
// permission prompts; default-on would fire the prompt the moment the
// desktop sent its first notification, which can read as unsolicited.
export async function loadPushNotificationsEnabled(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(NOTIF_KEY)
    if (raw === null) {
      return false
    }
    return raw === 'true'
  } catch {
    return false
  }
}

export async function savePushNotificationsEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(NOTIF_KEY, String(enabled))
}

const TEXT_SCALE_KEY = 'orca:terminalTextScale'

// Why: the mobile terminal fits the desktop's full column count to the phone
// width with a CSS scale, so xterm's raw fontSize is cancelled out and can't
// drive apparent size. Instead we persist a baseline zoom multiplier ("text
// size") that the WebView applies on top of the fit. Discrete presets keep the
// settings picker simple and bound the value to ones the zoom logic handles;
// pinch-to-zoom in the terminal snaps to these same presets. Sub-1 steps shrink
// below fit-to-width (more columns visible with side margins).
export const TERMINAL_TEXT_SCALES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const
const DEFAULT_TEXT_SCALE = 1

export async function loadTerminalTextScale(): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(TEXT_SCALE_KEY)
    if (raw === null) {
      return DEFAULT_TEXT_SCALE
    }
    const parsed = Number(raw)
    return (TERMINAL_TEXT_SCALES as readonly number[]).includes(parsed)
      ? parsed
      : DEFAULT_TEXT_SCALE
  } catch {
    return DEFAULT_TEXT_SCALE
  }
}

export async function saveTerminalTextScale(scale: number): Promise<void> {
  await AsyncStorage.setItem(TEXT_SCALE_KEY, String(scale))
}

const AUTOCOMPLETE_KEY = 'orca:terminalAutocompleteEnabled'

// Why: terminal command inputs default to autocorrect/suggestions OFF so the
// keyboard never mangles commands, flags, or paths. Users who want phone-style
// typing opt in via Settings → Terminal; the choice persists locally per device.
export async function loadTerminalAutocompleteEnabled(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(AUTOCOMPLETE_KEY)
    return raw === 'true'
  } catch {
    return false
  }
}

export async function saveTerminalAutocompleteEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(AUTOCOMPLETE_KEY, String(enabled))
}

const TERMINAL_LIVE_INPUT_DISABLED_PREFIX = 'orca:terminalLiveInputDisabled:'

export type DisabledTerminalLiveInputHandlesPreference = {
  readonly handles: Set<string>
  readonly loaded: boolean
}

function terminalLiveInputDisabledKey(hostId: string, worktreeId: string): string {
  return `${TERMINAL_LIVE_INPUT_DISABLED_PREFIX}${encodeURIComponent(hostId)}:${encodeURIComponent(
    worktreeId
  )}`
}

export async function readDisabledTerminalLiveInputHandlesPreference(
  hostId: string,
  worktreeId: string
): Promise<DisabledTerminalLiveInputHandlesPreference> {
  try {
    const raw = await AsyncStorage.getItem(terminalLiveInputDisabledKey(hostId, worktreeId))
    if (!raw) {
      return { handles: new Set(), loaded: true }
    }
    return { handles: new Set(stringArray(JSON.parse(raw))), loaded: true }
  } catch {
    return { handles: new Set(), loaded: false }
  }
}

export async function loadDisabledTerminalLiveInputHandles(
  hostId: string,
  worktreeId: string
): Promise<Set<string>> {
  const preference = await readDisabledTerminalLiveInputHandlesPreference(hostId, worktreeId)
  return preference.handles
}

export async function saveDisabledTerminalLiveInputHandles(
  hostId: string,
  worktreeId: string,
  handles: ReadonlySet<string>
): Promise<void> {
  await AsyncStorage.setItem(
    terminalLiveInputDisabledKey(hostId, worktreeId),
    JSON.stringify([...handles])
  )
}

const SIDEBAR_WIDTH_KEY = 'orca:hostSidebarWidth'

// Bounds for the draggable host worktree-list sidebar on tablet/foldable
// layouts (mirrors the desktop's resizable sidebar). The caller additionally
// caps the max against the window so the detail pane keeps usable space.
export const HOST_SIDEBAR_MIN_WIDTH = 280
export const HOST_SIDEBAR_MAX_WIDTH = 560
export const HOST_SIDEBAR_DEFAULT_WIDTH = 340

export function clampHostSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return HOST_SIDEBAR_DEFAULT_WIDTH
  }
  return Math.min(HOST_SIDEBAR_MAX_WIDTH, Math.max(HOST_SIDEBAR_MIN_WIDTH, Math.round(width)))
}

export async function loadHostSidebarWidth(): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(SIDEBAR_WIDTH_KEY)
    if (raw === null) {
      return HOST_SIDEBAR_DEFAULT_WIDTH
    }
    return clampHostSidebarWidth(Number(raw))
  } catch {
    return HOST_SIDEBAR_DEFAULT_WIDTH
  }
}

export async function saveHostSidebarWidth(width: number): Promise<void> {
  await AsyncStorage.setItem(SIDEBAR_WIDTH_KEY, String(clampHostSidebarWidth(width)))
}

const DOCK_WIDTH_KEY = 'orca:hostDockWidth'

// Bounds for the draggable right-hand session dock (Source Control / Files / PR)
// on wide layouts. Mirrors the left worktree-list sidebar's bounds so the two
// resizable columns read as a matched pair; the default matches the left default.
// The caller additionally caps the max against the window so the terminal keeps
// usable space.
export const HOST_DOCK_MIN_WIDTH = 280
export const HOST_DOCK_MAX_WIDTH = 560
export const HOST_DOCK_DEFAULT_WIDTH = 340

export function clampHostDockWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return HOST_DOCK_DEFAULT_WIDTH
  }
  return Math.min(HOST_DOCK_MAX_WIDTH, Math.max(HOST_DOCK_MIN_WIDTH, Math.round(width)))
}

export async function loadHostDockWidth(): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(DOCK_WIDTH_KEY)
    if (raw === null) {
      return HOST_DOCK_DEFAULT_WIDTH
    }
    return clampHostDockWidth(Number(raw))
  } catch {
    return HOST_DOCK_DEFAULT_WIDTH
  }
}

export async function saveHostDockWidth(width: number): Promise<void> {
  await AsyncStorage.setItem(DOCK_WIDTH_KEY, String(clampHostDockWidth(width)))
}

export type MobileTerminalLinkOpenMode = 'orca-browser' | 'phone-browser'

const TERMINAL_LINK_OPEN_MODE_KEY = 'orca:terminalLinkOpenMode'
export const DEFAULT_TERMINAL_LINK_OPEN_MODE: MobileTerminalLinkOpenMode = 'orca-browser'

export async function loadTerminalLinkOpenMode(): Promise<MobileTerminalLinkOpenMode> {
  try {
    const raw = await AsyncStorage.getItem(TERMINAL_LINK_OPEN_MODE_KEY)
    return raw === 'phone-browser' || raw === 'orca-browser' ? raw : DEFAULT_TERMINAL_LINK_OPEN_MODE
  } catch {
    return DEFAULT_TERMINAL_LINK_OPEN_MODE
  }
}

export async function saveTerminalLinkOpenMode(mode: MobileTerminalLinkOpenMode): Promise<void> {
  await AsyncStorage.setItem(TERMINAL_LINK_OPEN_MODE_KEY, mode)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

export async function loadPinnedIds(hostId: string): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(PINS_PREFIX + hostId)
    if (!raw) {
      return new Set()
    }
    return new Set(stringArray(JSON.parse(raw)))
  } catch {
    return new Set()
  }
}

export async function savePinnedIds(hostId: string, ids: Set<string>): Promise<void> {
  await AsyncStorage.setItem(PINS_PREFIX + hostId, JSON.stringify([...ids]))
}

const VISIBLE_USAGE_PROVIDERS_KEY = 'orca:visibleUsageProviders'

// Why: intersect stored ids with the known descriptor ids so a removed,
// misspelled, or future id can't linger in the set or silently re-enable a
// provider after an id is reused. An explicit empty set is a valid "show none".
function knownVisibleUsageProviders(ids: string[]): UsageProviderKey[] {
  return USAGE_PROVIDER_IDS.filter((id) => ids.includes(id))
}

// Distinguishes an I/O read failure from corrupt content. Only the I/O failure
// propagates: a write must abort on it (it can't know the real stored set), but
// corrupt content — missing, malformed JSON, or a non-array — normalizes to the
// default so a toggle can self-heal it. loadVisibleUsageProviders maps the I/O
// failure to the default for display; a write re-bases on the default and
// rewrites, which repairs the stored value.
async function readVisibleUsageProviders(): Promise<Set<UsageProviderKey>> {
  const raw = await AsyncStorage.getItem(VISIBLE_USAGE_PROVIDERS_KEY)
  if (raw === null) {
    return new Set(DEFAULT_VISIBLE_USAGE_PROVIDERS)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return new Set(DEFAULT_VISIBLE_USAGE_PROVIDERS)
  }
  // Only a real array carries the "explicit empty set = show none" semantics;
  // corrupted non-array JSON (e.g. `{}`) falls back to the default instead.
  if (!Array.isArray(parsed)) {
    return new Set(DEFAULT_VISIBLE_USAGE_PROVIDERS)
  }
  return new Set(knownVisibleUsageProviders(stringArray(parsed)))
}

export async function loadVisibleUsageProviders(): Promise<Set<UsageProviderKey>> {
  try {
    return await readVisibleUsageProviders()
  } catch {
    return new Set(DEFAULT_VISIBLE_USAGE_PROVIDERS)
  }
}

export async function saveVisibleUsageProviders(ids: ReadonlySet<UsageProviderKey>): Promise<void> {
  // Persist in canonical descriptor order so the stored value is stable.
  await AsyncStorage.setItem(
    VISIBLE_USAGE_PROVIDERS_KEY,
    JSON.stringify(USAGE_PROVIDER_IDS.filter((id) => ids.has(id)))
  )
}

// Serialize toggles so two fast switches can't lose each other through a
// read-modify-write race on the same key: each toggle re-reads the latest
// stored set and changes only its own provider, so it never clobbers a
// provider it didn't touch. ponytail: a module-level chain is enough for the
// single settings screen; revisit if more writers appear.
let visibleUsageWrite: Promise<Set<UsageProviderKey>> = Promise.resolve(new Set())

export function setUsageProviderVisible(
  id: UsageProviderKey,
  value: boolean
): Promise<Set<UsageProviderKey>> {
  visibleUsageWrite = visibleUsageWrite
    .catch(() => undefined)
    .then(async () => {
      // Strict read: if the read fails, abort the write rather than clobber the
      // stored set with the default (which would drop stored-only providers).
      const next = await readVisibleUsageProviders()
      if (value) {
        next.add(id)
      } else {
        next.delete(id)
      }
      await saveVisibleUsageProviders(next)
      return next
    })
  return visibleUsageWrite
}

// Read after any in-flight toggle settles, so a screen that re-mounts right
// after a toggle sees the just-written value instead of a pre-write snapshot.
export function loadVisibleUsageProvidersSettled(): Promise<Set<UsageProviderKey>> {
  return visibleUsageWrite.catch(() => undefined).then(() => loadVisibleUsageProviders())
}
