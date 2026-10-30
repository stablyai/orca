import AsyncStorage from '@react-native-async-storage/async-storage'
import { persistMirrored } from './mirrored-storage-keys'
import { TERMINAL_TEXT_SCALES } from '../terminal/terminal-text-scales'
import { HOST_SIDEBAR_MIN_WIDTH } from '../layout/responsive-layout-metrics'

const PINS_PREFIX = 'orca:pins:'
// Push-service consent is independent of legacy socket notifications.
const NOTIF_KEY = 'orca:pushServiceNotificationsEnabled'

export type PushNotificationsPreference = {
  readonly value: boolean | null
  readonly loaded: boolean
}

// Null means no onboarding choice; false includes explicit Not now or disabling later.
export async function readPushNotificationsPreference(): Promise<PushNotificationsPreference> {
  try {
    const raw = await AsyncStorage.getItem(NOTIF_KEY)
    return { value: raw === null ? null : raw === 'true', loaded: true }
  } catch {
    return { value: null, loaded: false }
  }
}

// Default off so background events cannot request OS permission; only user actions may do that.
export async function loadPushNotificationsEnabled(): Promise<boolean> {
  const preference = await readPushNotificationsPreference()
  return preference.value ?? false
}

export async function savePushNotificationsEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(NOTIF_KEY, String(enabled))
}

const REMOTE_PUSH_HOST_REGISTRATIONS_KEY = 'orca:remotePushHostRegistrations'

// Persist unregister retries: disabling while a host is offline otherwise leaves its gateway token live.
export type RemotePushHostRegistrations = {
  readonly registeredHostIds: readonly string[]
  readonly pendingUnregisterHostIds: readonly string[]
}

const EMPTY_REMOTE_PUSH_HOST_REGISTRATIONS: RemotePushHostRegistrations = {
  registeredHostIds: [],
  pendingUnregisterHostIds: []
}

export async function loadRemotePushHostRegistrations(): Promise<RemotePushHostRegistrations> {
  try {
    const raw = await AsyncStorage.getItem(REMOTE_PUSH_HOST_REGISTRATIONS_KEY)
    if (!raw) {
      return EMPTY_REMOTE_PUSH_HOST_REGISTRATIONS
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      registeredHostIds: stringArray(parsed.registeredHostIds),
      pendingUnregisterHostIds: stringArray(parsed.pendingUnregisterHostIds)
    }
  } catch {
    return EMPTY_REMOTE_PUSH_HOST_REGISTRATIONS
  }
}

export async function saveRemotePushHostRegistrations(
  value: RemotePushHostRegistrations
): Promise<void> {
  await AsyncStorage.setItem(REMOTE_PUSH_HOST_REGISTRATIONS_KEY, JSON.stringify(value))
}

const TEXT_SCALE_KEY = 'orca:terminalTextScale'

// Keep definitions in the bundled terminal document so it need not import storage.
export { TERMINAL_TEXT_SCALES } from '../terminal/terminal-text-scales'
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
  const value = String(scale)
  await persistMirrored(TEXT_SCALE_KEY, value)
}

const AUTOCOMPLETE_KEY = 'orca:terminalAutocompleteEnabled'

// Default autocorrect off so keyboards cannot alter commands, flags or paths; phone-style typing is opt-in.
export async function loadTerminalAutocompleteEnabled(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(AUTOCOMPLETE_KEY)
    return raw === 'true'
  } catch {
    return false
  }
}

export async function saveTerminalAutocompleteEnabled(enabled: boolean): Promise<void> {
  const value = String(enabled)
  await persistMirrored(AUTOCOMPLETE_KEY, value)
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
  const key = terminalLiveInputDisabledKey(hostId, worktreeId)
  const value = JSON.stringify([...handles])
  await persistMirrored(key, value)
}

const SIDEBAR_WIDTH_KEY = 'orca:hostSidebarWidth'

// Caller also caps this tablet/foldable sidebar against the window to preserve detail space.
export { HOST_SIDEBAR_MIN_WIDTH }
export const HOST_SIDEBAR_MAX_WIDTH = 560

export function clampHostSidebarWidth(width: number): number {
  return Math.min(HOST_SIDEBAR_MAX_WIDTH, Math.max(HOST_SIDEBAR_MIN_WIDTH, Math.round(width)))
}

// Null until the user drags the sidebar; the layout then sizes it from the window.
export async function loadHostSidebarWidth(): Promise<number | null> {
  try {
    const width = Number((await AsyncStorage.getItem(SIDEBAR_WIDTH_KEY)) ?? Number.NaN)
    return Number.isFinite(width) ? clampHostSidebarWidth(width) : null
  } catch {
    return null
  }
}

export async function saveHostSidebarWidth(width: number): Promise<void> {
  const value = String(clampHostSidebarWidth(width))
  await persistMirrored(SIDEBAR_WIDTH_KEY, value)
}

const DOCK_WIDTH_KEY = 'orca:hostDockWidth'

// Match left sidebar bounds; caller caps the dock against window width to preserve terminal space.
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
  const value = String(clampHostDockWidth(width))
  await persistMirrored(DOCK_WIDTH_KEY, value)
}

export type MobileTerminalLinkOpenMode = 'orca-browser' | 'phone-browser'

const TERMINAL_LINK_OPEN_MODE_KEY = 'orca:terminalLinkOpenMode'
export const DEFAULT_TERMINAL_LINK_OPEN_MODE: MobileTerminalLinkOpenMode = 'orca-browser'
let terminalLinkWriteBarrier: Promise<void> | null = null

export async function loadTerminalLinkOpenMode(): Promise<MobileTerminalLinkOpenMode> {
  await terminalLinkWriteBarrier
  try {
    const raw = await AsyncStorage.getItem(TERMINAL_LINK_OPEN_MODE_KEY)
    return raw === 'phone-browser' || raw === 'orca-browser' ? raw : DEFAULT_TERMINAL_LINK_OPEN_MODE
  } catch {
    return DEFAULT_TERMINAL_LINK_OPEN_MODE
  }
}

export function saveTerminalLinkOpenMode(mode: MobileTerminalLinkOpenMode): Promise<void> {
  const write = (terminalLinkWriteBarrier ?? Promise.resolve()).then(() =>
    persistMirrored(TERMINAL_LINK_OPEN_MODE_KEY, mode)
  )
  const barrier = write.catch(() => undefined)
  terminalLinkWriteBarrier = barrier
  void barrier.then(() => {
    if (terminalLinkWriteBarrier === barrier) {
      terminalLinkWriteBarrier = null
    }
  })
  return write
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
  const key = PINS_PREFIX + hostId
  const value = JSON.stringify([...ids])
  await persistMirrored(key, value)
}
