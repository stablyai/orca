import AsyncStorage from '@react-native-async-storage/async-storage'
import { persistMirrored } from './mirrored-storage-keys'
import type { AgentLaunchSurface } from '../../../src/shared/agent-launch/contracts/agent-launch-surface'
import { isNativeChatSupportedAgent } from '../../../src/shared/native-chat/native-chat-agent-support'
import { PAGE_STORAGE_MAX_VALUE_CHARS } from '../mobile-web-shell/page-storage/page-storage-keys'

export type MobileSessionView = 'terminal' | 'chat'
export type MobileSessionViewOverride = MobileSessionView | 'launch-terminal'

const DEFAULT_SESSION_VIEW_KEY = 'orca:defaultSessionView'
const NATIVE_CHAT_TABS_PREFIX = 'orca:nativeChatTabs:'

// Default to terminal; native chat is opt-in.
export const DEFAULT_SESSION_VIEW: MobileSessionView = 'terminal'

let defaultViewWriteBarrier: Promise<void> | null = null
const overrideUpdateBarriers = new Map<string, Promise<void>>()

function sessionViewOverridesKey(hostId: string, worktreeId: string): string {
  return `${NATIVE_CHAT_TABS_PREFIX}${encodeURIComponent(hostId)}:${encodeURIComponent(worktreeId)}`
}

function clearDefaultViewWriteBarrier(barrier: Promise<void>): void {
  if (defaultViewWriteBarrier === barrier) {
    defaultViewWriteBarrier = null
  }
}

export type DefaultSessionViewPreference = {
  readonly value: MobileSessionView | null
  readonly loaded: boolean
  readonly hasStoredValue: boolean
}

export async function readDefaultSessionViewPreference(): Promise<DefaultSessionViewPreference> {
  await defaultViewWriteBarrier
  try {
    const raw = await AsyncStorage.getItem(DEFAULT_SESSION_VIEW_KEY)
    return {
      value: raw === 'chat' || raw === 'terminal' ? raw : null,
      loaded: true,
      hasStoredValue: raw !== null
    }
  } catch {
    return { value: null, loaded: false, hasStoredValue: false }
  }
}

export async function loadDefaultSessionView(): Promise<MobileSessionView> {
  return (await readDefaultSessionViewPreference()).value ?? DEFAULT_SESSION_VIEW
}

/** The view to ask the host for on an agent tab this phone starts, so a chat here opens as a chat on the desktop too. */
export async function hostViewModeForNewAgentTab(
  agent: string | null | undefined
): Promise<'chat' | undefined> {
  if (!isNativeChatSupportedAgent(agent)) {
    return undefined
  }
  return (await loadDefaultSessionView()) === 'chat' ? 'chat' : undefined
}

export function saveDefaultSessionView(view: MobileSessionView): Promise<void> {
  // Share the write barrier across route remounts so an older save cannot overwrite a newer choice.
  const write = (defaultViewWriteBarrier ?? Promise.resolve()).then(() => {
    return persistMirrored(DEFAULT_SESSION_VIEW_KEY, view)
  })
  const barrier = write.catch(() => undefined)
  defaultViewWriteBarrier = barrier
  void barrier.then(() => clearDefaultViewWriteBarrier(barrier))
  return write
}

const NEW_AGENT_SURFACE_KEY = 'orca:newAgentSurface'

/** The Chat or CLI pick from the New Tab sheet; null until this device has made one. */
export async function loadNewAgentSurface(): Promise<AgentLaunchSurface | null> {
  try {
    const raw = await AsyncStorage.getItem(NEW_AGENT_SURFACE_KEY)
    return raw === 'chat' || raw === 'terminal' ? raw : null
  } catch {
    return null
  }
}

export function saveNewAgentSurface(surface: AgentLaunchSurface | null): Promise<void> {
  return persistMirrored(NEW_AGENT_SURFACE_KEY, surface)
}

export type SessionViewOverridesPreference = {
  overrides: Map<string, MobileSessionViewOverride>
  loaded: boolean
}

async function readSessionViewOverridesStorage(
  key: string
): Promise<SessionViewOverridesPreference> {
  let raw: string | null
  try {
    raw = await AsyncStorage.getItem(key)
  } catch {
    return { overrides: new Map(), loaded: false }
  }
  if (!raw) {
    return { overrides: new Map(), loaded: true }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return { overrides: new Map(), loaded: true }
  }
  if (Array.isArray(parsed)) {
    return {
      overrides: new Map(
        parsed
          .filter((id): id is string => typeof id === 'string')
          .map((id) => [id, 'chat' as const])
      ),
      loaded: true
    }
  }
  if (parsed && typeof parsed === 'object') {
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, MobileSessionViewOverride] =>
        entry[1] === 'terminal' || entry[1] === 'chat' || entry[1] === 'launch-terminal'
    )
    return { overrides: new Map(entries), loaded: true }
  }
  return { overrides: new Map(), loaded: true }
}

// Scope overrides by host/worktree so colliding tab ids cannot activate another host’s transcript watcher.
export async function loadSessionViewOverrides(
  hostId: string,
  worktreeId: string
): Promise<Map<string, MobileSessionViewOverride>> {
  return (await readSessionViewOverridesPreference(hostId, worktreeId)).overrides
}

// Distinguish empty preferences from unavailable storage.
export async function readSessionViewOverridesPreference(
  hostId: string,
  worktreeId: string
): Promise<SessionViewOverridesPreference> {
  const key = sessionViewOverridesKey(hostId, worktreeId)
  await overrideUpdateBarriers.get(key)
  return readSessionViewOverridesStorage(key)
}

// Apply one mutation without replacing another mount’s sibling overrides.
export async function updateSessionViewOverride(
  hostId: string,
  worktreeId: string,
  tabId: string,
  view: MobileSessionViewOverride
): Promise<void> {
  const key = sessionViewOverridesKey(hostId, worktreeId)
  const previous = overrideUpdateBarriers.get(key) ?? Promise.resolve()
  const update = previous.then(async () => {
    const current = await readSessionViewOverridesStorage(key)
    // Read failure must not replace saved siblings with a partial map containing only this tab.
    if (!current.loaded) {
      throw new Error('Session view overrides could not be read')
    }
    if (view === 'launch-terminal' && current.overrides.has(tabId)) {
      return
    }
    current.overrides.set(tabId, view)
    let value = JSON.stringify(Object.fromEntries(current.overrides))
    // Prefer manual view choices when accumulated launch preferences reach the bridge's storage limit.
    for (const [id, stored] of current.overrides) {
      if (value.length <= PAGE_STORAGE_MAX_VALUE_CHARS) {
        break
      }
      if (stored === 'launch-terminal') {
        current.overrides.delete(id)
        value = JSON.stringify(Object.fromEntries(current.overrides))
      }
    }
    await persistMirrored(key, value)
  })
  const barrier = update.catch(() => undefined)
  overrideUpdateBarriers.set(key, barrier)
  try {
    await update
  } finally {
    if (overrideUpdateBarriers.get(key) === barrier) {
      overrideUpdateBarriers.delete(key)
    }
  }
}
