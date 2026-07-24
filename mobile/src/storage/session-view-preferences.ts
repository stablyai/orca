import AsyncStorage from '@react-native-async-storage/async-storage'

/** How a supported agent session opens: the raw terminal or the native chat view. */
export type MobileSessionView = 'terminal' | 'chat'

const DEFAULT_SESSION_VIEW_KEY = 'orca:defaultSessionView'
const NATIVE_CHAT_TABS_PREFIX = 'orca:nativeChatTabs:'
export const SESSION_VIEW_OVERRIDE_MAX_ENTRIES = 4_096
export const SESSION_VIEW_OVERRIDE_MAX_STORAGE_CHARACTERS = 512 * 1024
export const SESSION_VIEW_OVERRIDE_MAX_TAB_ID_CHARACTERS = 1_024
export const SESSION_VIEW_OVERRIDE_MAX_ACTIVE_BARRIERS = 64
const SESSION_VIEW_OVERRIDE_MAX_SCOPE_KEY_CHARACTERS = 4_096

// Why: default stays terminal so native chat remains strictly opt-in.
export const DEFAULT_SESSION_VIEW: MobileSessionView = 'terminal'

let defaultViewWriteBarrier: Promise<void> | null = null
const overrideUpdateBarriers = new Map<string, Promise<void>>()

function sessionViewOverridesKey(hostId: string, worktreeId: string): string | null {
  const key = `${NATIVE_CHAT_TABS_PREFIX}${encodeURIComponent(hostId)}:${encodeURIComponent(
    worktreeId
  )}`
  return key.length <= SESSION_VIEW_OVERRIDE_MAX_SCOPE_KEY_CHARACTERS ? key : null
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
  if (raw.length > SESSION_VIEW_OVERRIDE_MAX_STORAGE_CHARACTERS) {
    return { overrides: new Map(), loaded: false }
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
    const overrides = new Map<string, MobileSessionView>()
    for (const id of parsed) {
      if (typeof id !== 'string' || id.length > SESSION_VIEW_OVERRIDE_MAX_TAB_ID_CHARACTERS) {
        continue
      }
      if (!overrides.has(id) && overrides.size >= SESSION_VIEW_OVERRIDE_MAX_ENTRIES) {
        return { overrides: new Map(), loaded: false }
      }
      overrides.set(id, 'chat')
    }
    return { overrides, loaded: true }
  }
  if (parsed && typeof parsed === 'object') {
    const overrides = new Map<string, MobileSessionView>()
    const record = parsed as Record<string, unknown>
    for (const id in record) {
      if (!Object.prototype.hasOwnProperty.call(record, id)) {
        continue
      }
      const view = record[id]
      if (
        (view !== 'terminal' && view !== 'chat') ||
        id.length > SESSION_VIEW_OVERRIDE_MAX_TAB_ID_CHARACTERS
      ) {
        continue
      }
      if (overrides.size >= SESSION_VIEW_OVERRIDE_MAX_ENTRIES) {
        return { overrides: new Map(), loaded: false }
      }
      overrides.set(id, view)
    }
    return { overrides, loaded: true }
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
  if (!key) {
    return { overrides: new Map(), loaded: false }
  }
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
  if (!key || tabId.length === 0 || tabId.length > SESSION_VIEW_OVERRIDE_MAX_TAB_ID_CHARACTERS) {
    throw new Error('Session view override identifier is too large')
  }
  const existingBarrier = overrideUpdateBarriers.get(key)
  if (
    !existingBarrier &&
    overrideUpdateBarriers.size >= SESSION_VIEW_OVERRIDE_MAX_ACTIVE_BARRIERS
  ) {
    throw new Error('Too many session view override writes are pending')
  }
  const previous = existingBarrier ?? Promise.resolve()
  const update = previous.then(async () => {
    const current = await readSessionViewOverridesStorage(key)
    // Why: a transient read failure must not replace valid saved siblings with
    // a partial map containing only the latest tab.
    if (!current.loaded) {
      throw new Error('Session view overrides could not be read')
    }
    if (
      !current.overrides.has(tabId) &&
      current.overrides.size >= SESSION_VIEW_OVERRIDE_MAX_ENTRIES
    ) {
      const oldestId = current.overrides.keys().next().value
      if (typeof oldestId === 'string') {
        current.overrides.delete(oldestId)
      }
    }
    current.overrides.set(tabId, view)
    await AsyncStorage.setItem(key, serializeSessionViewOverrides(current.overrides, tabId))
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

function serializeSessionViewOverrides(
  overrides: Map<string, MobileSessionView>,
  protectedId: string
): string {
  while (true) {
    const serialized = trySerializeSessionViewOverrides(overrides)
    if (serialized !== null) {
      return serialized
    }
    let evictionId: string | null = null
    for (const id of overrides.keys()) {
      if (id !== protectedId) {
        evictionId = id
        break
      }
    }
    if (evictionId === null) {
      throw new Error('Session view override storage limit exceeded')
    }
    overrides.delete(evictionId)
  }
}

function trySerializeSessionViewOverrides(
  overrides: ReadonlyMap<string, MobileSessionView>
): string | null {
  const entries: string[] = []
  let characters = 2
  for (const [id, view] of overrides) {
    const entry = `${JSON.stringify(id)}:${JSON.stringify(view)}`
    characters += entry.length + (entries.length > 0 ? 1 : 0)
    if (characters > SESSION_VIEW_OVERRIDE_MAX_STORAGE_CHARACTERS) {
      return null
    }
    entries.push(entry)
  }
  return `{${entries.join(',')}}`
}

/** Test-only: drop pending module write barriers between cases. */
export function resetSessionViewPreferencesForTests(): void {
  defaultViewWriteBarrier = null
  overrideUpdateBarriers.clear()
}
