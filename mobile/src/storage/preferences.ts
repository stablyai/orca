import AsyncStorage from '@react-native-async-storage/async-storage'

const PINS_PREFIX = 'orca:pins:'
const NOTIF_KEY = 'orca:pushNotificationsEnabled'
const NATIVE_CHAT_TABS_PREFIX = 'orca:nativeChatTabs:'

function nativeChatTabIdsKey(hostId: string, worktreeId: string): string {
  return `${NATIVE_CHAT_TABS_PREFIX}${encodeURIComponent(hostId)}:${encodeURIComponent(worktreeId)}`
}

/** Tab ids currently showing native chat, scoped to the paired host and worktree
 *  so colliding remote ids cannot activate a transcript watcher on another host. */
export async function loadNativeChatTabIds(hostId: string, worktreeId: string): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(nativeChatTabIdsKey(hostId, worktreeId))
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

export async function saveNativeChatTabIds(
  hostId: string,
  worktreeId: string,
  ids: string[]
): Promise<void> {
  try {
    await AsyncStorage.setItem(nativeChatTabIdsKey(hostId, worktreeId), JSON.stringify(ids))
  } catch {
    // Best-effort persistence; a failed write just forgets the view choice.
  }
}

export type PushNotificationsPreference = {
  readonly value: boolean | null
  readonly loaded: boolean
}

// Why: null distinguishes people who have never made the one-time onboarding
// decision from people who explicitly chose Not now or disabled notifications.
export async function readPushNotificationsPreference(): Promise<PushNotificationsPreference> {
  try {
    const raw = await AsyncStorage.getItem(NOTIF_KEY)
    return { value: raw === null ? null : raw === 'true', loaded: true }
  } catch {
    return { value: null, loaded: false }
  }
}

// Why: default-off prevents background notification events from opening the
// system prompt; only the onboarding CTA or Settings switch requests permission.
export async function loadPushNotificationsEnabled(): Promise<boolean> {
  const preference = await readPushNotificationsPreference()
  return preference.value ?? false
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
