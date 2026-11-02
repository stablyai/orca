import {
  PAGE_STORAGE_LIVE_KEYS,
  isHostWorkspaceStorageKey,
  isPageStorageKeyForRoute,
  PAGE_STORAGE_MAX_VALUE_CHARS
} from '../page-storage-keys'

// Use init-primed native storage, not page localStorage (disabled on Android and session-scoped on iOS).
// Keep reads synchronous behind AsyncStorage’s async API for first-render timing; writes update cache/post without waiting, and later init repairs dropped writes.
type PageStorageWriter = (key: string, value: string | null) => boolean

type PageStorageRefusal = 'not-allowed' | 'too-large' | 'not-delivered'

const REFUSAL_SENTENCES: Record<PageStorageRefusal, string> = {
  'not-allowed': 'this screen was not given that setting to write',
  'too-large': `a stored value may be at most ${String(PAGE_STORAGE_MAX_VALUE_CHARS)} characters`,
  'not-delivered': 'the app did not take the write'
}

// Reject only too-large writes: the durable journal’s composer catches that to prevent mutations with unpersisted operation ids (ruling 7).
// Unlisted/ungranted preferences drop silently because their callers have no rejection handlers; log the refusal instead (ruling 33.4).
export class PageStorageRefusedError extends Error {
  readonly refusal: PageStorageRefusal
  readonly key: string

  constructor(key: string, refusal: PageStorageRefusal) {
    super(`Orca could not save ${key}: ${REFUSAL_SENTENCES[refusal]}.`)
    this.name = 'PageStorageRefusedError'
    this.refusal = refusal
    this.key = key
  }
}

const values = new Map<string, string>()
let published = false
const keyListeners = new Map<string, Set<(value: string | null) => void>>()
let write: PageStorageWriter = () => false
// Refuse withheld oversized keys as too-large: the page holds no starting value, so any write would overwrite rather than extend the native value (ruling 33.6).
let oversizeKeys: ReadonlySet<string> = new Set()
let hostId = ''
let routePathname = ''
// Host-area pages read workspace-scoped keys on demand and may write them across this host’s workspaces.
let readWorkspaceKey: ((key: string) => Promise<string | null>) | null = null

export function publishPageStorage(
  entries: Readonly<Record<string, string>>,
  writer: PageStorageWriter,
  forHostId: string,
  forRoutePathname: string,
  forOversizeKeys: readonly string[] = [],
  forWorkspaceKeyReader: ((key: string) => Promise<string | null>) | null = null
): void {
  published = true
  values.clear()
  oversizeKeys = new Set(forOversizeKeys)
  for (const [key, value] of Object.entries(entries)) {
    values.set(key, value)
  }
  write = writer
  hostId = forHostId
  routePathname = forRoutePathname
  readWorkspaceKey = forWorkspaceKeyReader
}

/** Apply native shortcut settings and the shared chat text size without replacing drafts. */
export function refreshPageTerminalShortcuts(
  entries: Readonly<Record<string, string>>,
  oversize: readonly string[]
): void {
  const nextOversize = new Set(oversizeKeys)
  for (const key of PAGE_STORAGE_LIVE_KEYS) {
    const value = entries[key]
    put(key, value === undefined ? null : value)
    if (oversize.includes(key)) {
      nextOversize.add(key)
    } else {
      nextOversize.delete(key)
    }
  }
  oversizeKeys = nextOversize
}

function put(key: string, value: string | null): void {
  const had = values.has(key)
  const prev = had ? (values.get(key) ?? null) : null
  if ((value === null && !had) || prev === value) {
    return
  }
  if (value === null) {
    values.delete(key)
  } else {
    values.set(key, value)
  }
  for (const listener of keyListeners.get(key) ?? []) {
    listener(value)
  }
}

function subscribePageStorage(key: string, listener: (value: string | null) => void): () => void {
  const forKey = keyListeners.get(key) ?? new Set<(value: string | null) => void>()
  keyListeners.set(key, forKey)
  forKey.add(listener)
  return () => {
    forKey.delete(listener)
  }
}

// Undefined until publish: a missing key and a cache the shell has not primed are different answers.
function getItemSync(key: string): string | null | undefined {
  if (!published || (readWorkspaceKey !== null && isHostWorkspaceStorageKey(key, hostId))) {
    return undefined
  }
  return values.get(key) ?? null
}

function getItem(key: string): Promise<string | null> {
  return readWorkspaceKey !== null && isHostWorkspaceStorageKey(key, hostId)
    ? readWorkspaceKey(key)
    : Promise.resolve(values.get(key) ?? null)
}

// Never keep refused writes locally; an app-invisible cache value would make a pin appear persisted only to this document.
function accept(key: string, value: string | null): PageStorageRefusal | null {
  if (!isPageStorageKeyForRoute(key, hostId, routePathname, readWorkspaceKey !== null)) {
    return 'not-allowed'
  }
  // Use the envelope’s bound so cached values cannot exceed what the shell will write.
  if (value !== null && value.length > PAGE_STORAGE_MAX_VALUE_CHARS) {
    return 'too-large'
  }
  // Withheld oversized app values are unwritable too; without their initial contents a page write is destructive replacement.
  if (oversizeKeys.has(key)) {
    return 'too-large'
  }
  if (!write(key, value)) {
    return 'not-delivered'
  }
  put(key, value)
  return null
}

// Log refused writes but build plain errors first; discarded rejected promises would create unhandled rejections before the caller chooses its outcome.
function refusalError(
  key: string,
  refusal: PageStorageRefusal | null
): PageStorageRefusedError | null {
  if (refusal === null) {
    return null
  }
  if (refusal === 'too-large') {
    return new PageStorageRefusedError(key, refusal)
  }
  console.warn('[page-bridge] storage-write-dropped', { key, refusal })
  return null
}

function settle(key: string, refusal: PageStorageRefusal | null): Promise<void> {
  const error = refusalError(key, refusal)
  return error === null ? Promise.resolve() : Promise.reject(error)
}

// Apply pairs in order and stop at the first refusal: one batch has one result, not a reported failure mixed with later successful writes (ruling 35).
function applyBatch(pairs: readonly (readonly [string, string | null])[]): Promise<void> {
  for (const [key, value] of pairs) {
    const refusal = accept(key, value)
    if (refusal !== null) {
      return settle(key, refusal)
    }
  }
  return Promise.resolve()
}

const pageAsyncStorage = {
  getItem,
  getItemSync,
  subscribePageStorage,
  setItem: (key: string, value: string): Promise<void> => settle(key, accept(key, value)),
  removeItem: (key: string): Promise<void> => settle(key, accept(key, null)),
  multiGet: (keys: readonly string[]): Promise<[string, string | null][]> =>
    Promise.all(
      keys.map(async (key): Promise<[string, string | null]> => [key, await getItem(key)])
    ),
  multiSet: (pairs: readonly [string, string][]): Promise<void> => applyBatch(pairs),
  multiRemove: (keys: readonly string[]): Promise<void> =>
    applyBatch(keys.map((key) => [key, null] as const)),
  getAllKeys: (): Promise<string[]> => Promise.resolve([...values.keys()]),
  clear: (): Promise<void> => Promise.resolve()
}

export default pageAsyncStorage
