import AsyncStorage from '@react-native-async-storage/async-storage'
import { persistMirrored } from './mirrored-storage-keys'
import { TERMINAL_TEXT_SCALES } from '../terminal/terminal-text-scales'
import { DEFAULT_HOME_LAYOUT, normalizeHomeLayout, type HomeLayout } from '../home/home-layout'

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

const SIDEBAR_WIDTH_KEY = 'orca:hostSidebarWidth'

// Caller also caps this tablet/foldable sidebar against the window to preserve detail space.
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

export type TerminalSplitLayout = 'auto' | 'side-by-side' | 'stacked'
const TERMINAL_SPLIT_LAYOUT_KEY = 'orca:terminalSplitLayout'
let terminalSplitLayoutWrite: Promise<void> = Promise.resolve()

export async function loadTerminalSplitLayout(): Promise<TerminalSplitLayout> {
  await terminalSplitLayoutWrite
  const raw = await AsyncStorage.getItem(TERMINAL_SPLIT_LAYOUT_KEY)
  return raw === 'side-by-side' || raw === 'stacked' ? raw : 'auto'
}

export function saveTerminalSplitLayout(layout: TerminalSplitLayout): Promise<void> {
  const write = terminalSplitLayoutWrite.then(() =>
    persistMirrored(TERMINAL_SPLIT_LAYOUT_KEY, layout)
  )
  terminalSplitLayoutWrite = write.catch((error: unknown) => {
    console.warn('Terminal split layout could not be saved', error)
  })
  return write
}

const HOME_LAYOUT_KEY = 'orca:homeLayout'

// Missing or unreadable means the default layout; Home is native-only, so no page mirror.
export async function loadHomeLayout(): Promise<HomeLayout> {
  try {
    const raw = await AsyncStorage.getItem(HOME_LAYOUT_KEY)
    return raw === null ? DEFAULT_HOME_LAYOUT : normalizeHomeLayout(JSON.parse(raw))
  } catch {
    return DEFAULT_HOME_LAYOUT
  }
}

export async function saveHomeLayout(layout: HomeLayout): Promise<void> {
  await AsyncStorage.setItem(HOME_LAYOUT_KEY, JSON.stringify(layout))
}
