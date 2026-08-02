import AsyncStorage from '@react-native-async-storage/async-storage'

/** How a supported agent session opens: the raw terminal or the native chat view. */
export type MobileSessionView = 'terminal' | 'chat'

const DEFAULT_SESSION_VIEW_KEY = 'orca:defaultSessionView'
const NATIVE_CHAT_TABS_PREFIX = 'orca:nativeChatTabs:'

// Why: default stays terminal so native chat remains strictly opt-in.
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

/** Reads the raw per-device default and whether its storage key exists. */
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

/** Global (per-device) default for how supported agent sessions open. */
export async function loadDefaultSessionView(): Promise<MobileSessionView> {
  return (await readDefaultSessionViewPreference()).value ?? DEFAULT_SESSION_VIEW
}

export function saveDefaultSessionView(view: MobileSessionView): Promise<void> {
  // Why: callers can outlive their route; a shared barrier keeps remounted
  // Settings screens from letting an older write land after a newer choice.
  const write = (defaultViewWriteBarrier ?? Promise.resolve()).then(() =>
    AsyncStorage.setItem(DEFAULT_SESSION_VIEW_KEY, view)
  )
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
    // Invalid preference data is safe to replace on the next user mutation.
    return { overrides: new Map(), loaded: true }
  }
  // Legacy format: an array of tab ids that were showing native chat.
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

/** Per-tab session-view overrides that win over the global default, scoped to the
 *  paired host and worktree so colliding remote ids cannot activate a transcript
 *  watcher on another host. */
export async function loadSessionViewOverrides(
  hostId: string,
  worktreeId: string
): Promise<Map<string, MobileSessionView>> {
  return (await readSessionViewOverridesPreference(hostId, worktreeId)).overrides
}

/** Reads overrides without conflating an empty preference with unavailable storage. */
export async function readSessionViewOverridesPreference(
  hostId: string,
  worktreeId: string
): Promise<SessionViewOverridesPreference> {
  const key = sessionViewOverridesKey(hostId, worktreeId)
  await overrideUpdateBarriers.get(key)
  return readSessionViewOverridesStorage(key)
}

/** Persists one user mutation without replacing sibling overrides from another mount. */
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
    // Why: a transient read failure must not replace valid saved siblings with
    // a partial map containing only the latest tab.
    if (!current.loaded) {
      throw new Error('Session view overrides could not be read')
    }
    current.overrides.set(tabId, view)
    await AsyncStorage.setItem(key, JSON.stringify(Object.fromEntries(current.overrides)))
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
