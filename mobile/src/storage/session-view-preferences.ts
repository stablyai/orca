import AsyncStorage from '@react-native-async-storage/async-storage'
import { persistMirrored } from './mirrored-storage-keys'

export type MobileSessionView = 'terminal' | 'chat'

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

export type SessionViewOverridesPreference = {
  overrides: Map<string, MobileSessionView>
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
      (entry): entry is [string, MobileSessionView] =>
        entry[1] === 'terminal' || entry[1] === 'chat'
    )
    return { overrides: new Map(entries), loaded: true }
  }
  return { overrides: new Map(), loaded: true }
}

// Scope overrides by host/worktree so colliding tab ids cannot activate another host’s transcript watcher.
export async function loadSessionViewOverrides(
  hostId: string,
  worktreeId: string
): Promise<Map<string, MobileSessionView>> {
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
  view: MobileSessionView
): Promise<void> {
  const key = sessionViewOverridesKey(hostId, worktreeId)
  const previous = overrideUpdateBarriers.get(key) ?? Promise.resolve()
  const update = previous.then(async () => {
    const current = await readSessionViewOverridesStorage(key)
    // Read failure must not replace saved siblings with a partial map containing only this tab.
    if (!current.loaded) {
      throw new Error('Session view overrides could not be read')
    }
    current.overrides.set(tabId, view)
    const value = JSON.stringify(Object.fromEntries(current.overrides))
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
