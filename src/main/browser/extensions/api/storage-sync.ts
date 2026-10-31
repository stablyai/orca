import { z } from 'zod'
import { emitBrowserExtensionEvent } from '../browser-extension-api-host'
import {
  BrowserExtensionApiError,
  defineBrowserExtensionMethod,
  registerBrowserExtensionNamespace,
  type BrowserExtensionCaller
} from '../browser-extension-namespace-registry'
import {
  getBrowserExtensionSyncStorageStore,
  type BrowserExtensionSyncItems
} from '../browser-extension-sync-storage-store'

/**
 * Electron disables chrome.storage.sync ("not available in this instance of Chrome"), so Orca
 * backs it here, on this machine, as Chrome does for a user who is not signed in. Main is the only
 * writer, so every change carries exact old values. A write returns its changes to the caller,
 * which fires its own listeners (a starting worker's write can reach main before its listen
 * does); onChanged goes to the extension's other pages and its worker in the session.
 * The preload installs it as chrome.storage.sync (src/preload/browser-extension-storage-sync.ts).
 */
const STORAGE_SYNC_NAMESPACE = 'orcaStorageSync'

/** Chrome's sync limits Orca enforces; the preload exposes them (and the write rates) to extensions. */
export const STORAGE_SYNC_QUOTAS = {
  QUOTA_BYTES: 102_400,
  QUOTA_BYTES_PER_ITEM: 8192,
  MAX_ITEMS: 512
}

type StorageChanges = Record<string, { oldValue?: unknown; newValue?: unknown }>

const keyListSchema = z.union([z.string(), z.array(z.string())])
const itemsSchema = z.record(z.string(), z.unknown())
const getKeysSchema = z.union([z.null(), keyListSchema, itemsSchema]).optional()

/** Chrome stores JSON values: functions and undefined members drop out; undefined means "skip". */
function toStoredValue(value: unknown): unknown {
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch {
    throw new BrowserExtensionApiError('Values must be JSON-serializable')
  }
  return json === undefined ? undefined : JSON.parse(json)
}

// Chrome counts the key plus the value's JSON, in UTF-8 bytes.
function itemBytes(key: string, value: unknown): number {
  return Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value))
}

function bytesInUse(items: BrowserExtensionSyncItems, keys: string[]): number {
  return keys.reduce(
    (total, key) => (Object.hasOwn(items, key) ? total + itemBytes(key, items[key]) : total),
    0
  )
}

function quotaError(name: keyof typeof STORAGE_SYNC_QUOTAS): BrowserExtensionApiError {
  return new BrowserExtensionApiError(`${name} quota exceeded`)
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function readItems(caller: BrowserExtensionCaller): BrowserExtensionSyncItems {
  return getBrowserExtensionSyncStorageStore().read(caller.browserProfileId, caller.extension.id)
}

/** Saves `next`; returns and announces the changes for every key whose value differs. */
function commit(
  caller: BrowserExtensionCaller,
  current: BrowserExtensionSyncItems,
  next: BrowserExtensionSyncItems,
  keys: Iterable<string>
): StorageChanges {
  const changes: StorageChanges = {}
  for (const key of keys) {
    const had = Object.hasOwn(current, key)
    const has = Object.hasOwn(next, key)
    if ((had || has) && !(had && has && sameValue(current[key], next[key]))) {
      changes[key] = {
        ...(had ? { oldValue: current[key] } : {}),
        ...(has ? { newValue: next[key] } : {})
      }
    }
  }
  if (Object.keys(changes).length === 0) {
    return changes
  }
  getBrowserExtensionSyncStorageStore().write(caller.browserProfileId, caller.extension.id, next)
  emitBrowserExtensionEvent(
    { session: caller.session, extensionId: caller.extension.id, exceptCaller: caller },
    STORAGE_SYNC_NAMESPACE,
    'onChanged',
    [changes]
  )
  return changes
}

function get(
  caller: BrowserExtensionCaller,
  keys: z.infer<typeof getKeysSchema>
): BrowserExtensionSyncItems {
  const items = readItems(caller)
  if (keys == null) {
    return { ...items }
  }
  if (typeof keys === 'string' || Array.isArray(keys)) {
    return Object.fromEntries(
      [keys].flat().flatMap((key) => (Object.hasOwn(items, key) ? [[key, items[key]]] : []))
    )
  }
  const result: BrowserExtensionSyncItems = {}
  for (const [key, fallback] of Object.entries(keys)) {
    const value = Object.hasOwn(items, key) ? items[key] : toStoredValue(fallback)
    if (value !== undefined) {
      result[key] = value
    }
  }
  return result
}

function set(caller: BrowserExtensionCaller, input: BrowserExtensionSyncItems): StorageChanges {
  const current = readItems(caller)
  const next = { ...current }
  let total = bytesInUse(current, Object.keys(current))
  for (const [key, raw] of Object.entries(input)) {
    const value = toStoredValue(raw)
    if (value === undefined) {
      continue
    }
    const size = itemBytes(key, value)
    if (size > STORAGE_SYNC_QUOTAS.QUOTA_BYTES_PER_ITEM) {
      throw quotaError('QUOTA_BYTES_PER_ITEM')
    }
    total += size - bytesInUse(next, [key])
    next[key] = value
  }
  if (total > STORAGE_SYNC_QUOTAS.QUOTA_BYTES) {
    throw quotaError('QUOTA_BYTES')
  }
  if (Object.keys(next).length > STORAGE_SYNC_QUOTAS.MAX_ITEMS) {
    throw quotaError('MAX_ITEMS')
  }
  return commit(caller, current, next, Object.keys(input))
}

function remove(
  caller: BrowserExtensionCaller,
  keys: z.infer<typeof keyListSchema>
): StorageChanges {
  const current = readItems(caller)
  const next = { ...current }
  for (const key of [keys].flat()) {
    delete next[key]
  }
  return commit(caller, current, next, [keys].flat())
}

export function registerStorageSyncNamespace(): void {
  // Preload-only: installed as chrome.storage.sync, never as its own chrome namespace.
  registerBrowserExtensionNamespace(STORAGE_SYNC_NAMESPACE, {
    permission: 'storage',
    methods: {
      get: defineBrowserExtensionMethod(z.tuple([getKeysSchema]), get),
      getKeys: defineBrowserExtensionMethod(z.tuple([]), (caller) =>
        Object.keys(readItems(caller))
      ),
      getBytesInUse: defineBrowserExtensionMethod(
        z.tuple([z.union([z.null(), keyListSchema]).optional()]),
        (caller, keys) => {
          const items = readItems(caller)
          return bytesInUse(items, keys == null ? Object.keys(items) : [keys].flat())
        }
      ),
      set: defineBrowserExtensionMethod(z.tuple([itemsSchema]), set),
      remove: defineBrowserExtensionMethod(z.tuple([keyListSchema]), remove),
      clear: defineBrowserExtensionMethod(z.tuple([]), (caller) => {
        const current = readItems(caller)
        return commit(caller, current, {}, Object.keys(current))
      })
    },
    events: ['onChanged']
  })
}
