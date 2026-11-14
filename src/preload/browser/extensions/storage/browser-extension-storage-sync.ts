import type {
  BrowserExtensionInvokeReply,
  BrowserExtensionMainWorldBridge
} from '../api/browser-extension-main-world'

/** Main-only namespace backing chrome.storage.sync; never installed on `chrome` by that name. */
export const PRELOAD_STORAGE_SYNC_NAMESPACE = 'orcaStorageSync'

/** chrome.storage.sync's constants. Main enforces the size limits; write rates are not enforced. */
export const PRELOAD_STORAGE_SYNC_CONSTANTS: Record<string, number> = {
  QUOTA_BYTES: 102_400,
  QUOTA_BYTES_PER_ITEM: 8192,
  MAX_ITEMS: 512,
  MAX_WRITE_OPERATIONS_PER_HOUR: 1800,
  MAX_WRITE_OPERATIONS_PER_MINUTE: 120,
  MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE: 1_000_000
}

/**
 * Runs a content script's sync call here, as if this context made it (see the content-script
 * relay). `from` names the calling content script so its own changes are not sent back to it.
 */
export type BrowserExtensionStorageSyncRelay = (
  method: string,
  args: unknown[],
  from?: string
) => Promise<BrowserExtensionInvokeReply>

/** The worker's way to pass every sync change it sees on to its content scripts. */
export type BrowserExtensionStorageSyncForward = (
  changes: Record<string, unknown>,
  from?: string
) => void

type ApiObject = Record<string, unknown>
type ExtensionCallable = (...args: unknown[]) => unknown

/**
 * Electron disables chrome.storage.sync, so this replaces it with an area main stores (see
 * src/main/browser/extensions/api/storage-sync.ts) and makes chrome.storage.onChanged also deliver
 * main's 'sync' changes, around whatever onChanged is installed (native in pages, the storage
 * relay's in workers). Run it after installBrowserExtensionStorageRelay. Returns the entry point the
 * worker answers content scripts' relayed calls through, or null when there is no storage API.
 *
 * Self-contained for the same reason as installBrowserExtensionApis: pages serialize it.
 */
export function installBrowserExtensionStorageSync(
  bridge: BrowserExtensionMainWorldBridge,
  constants: Record<string, number>,
  forward?: BrowserExtensionStorageSyncForward,
  areaName: 'sync' | 'session' = 'sync'
): BrowserExtensionStorageSyncRelay | null {
  const namespace = areaName === 'session' ? 'orcaStorageSession' : 'orcaStorageSync'
  const isObject = (value: unknown): value is ApiObject =>
    value !== null && typeof value === 'object'
  const isCallable = (value: unknown): value is ExtensionCallable => typeof value === 'function'
  const root: { chrome?: unknown; browser?: unknown } = globalThis
  const chromeApi = root.chrome
  if (!isObject(chromeApi) || !isObject(chromeApi.storage)) {
    return null
  }
  const define = (target: ApiObject, key: string, value: unknown): void => {
    try {
      Object.defineProperty(target, key, {
        value,
        configurable: true,
        enumerable: true,
        writable: true
      })
    } catch {
      // Frozen native object: leave it.
    }
  }
  const callWithLastError = (message: string, callback: () => void): void => {
    const runtime = isObject(chromeApi.runtime) ? chromeApi.runtime : null
    let defined = false
    if (runtime) {
      try {
        Object.defineProperty(runtime, 'lastError', {
          configurable: true,
          get: () => ({ message })
        })
        defined = true
      } catch {
        // Native lastError cannot be replaced here; the callback still runs.
      }
    }
    try {
      callback()
    } finally {
      if (defined && runtime) {
        delete runtime.lastError
      }
    }
  }
  // Chrome stores JSON; converting here also keeps IPC from rejecting functions inside values.
  const normalize = (value: unknown, ancestors = new Set<object>(), depth = 0): unknown => {
    if (depth > 100) {
      return undefined
    }
    if (typeof value === 'string') {
      return value.toWellFormed()
    }
    if (value === null || typeof value === 'boolean') {
      return value
    }
    if (typeof value === 'number') {
      return Number.isFinite(value) ? (value === 0 ? 0 : value) : undefined
    }
    if (typeof value !== 'object') {
      return undefined
    }
    if (value instanceof ArrayBuffer) {
      return value.slice(0)
    }
    if (ArrayBuffer.isView(value)) {
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
    }
    if (ancestors.has(value)) {
      return null
    }
    ancestors.add(value)
    try {
      if (Array.isArray(value)) {
        return Array.from({ length: value.length }, (_, index) => {
          if (!Object.hasOwn(value, index)) {
            return null
          }
          try {
            return normalize(value[index], ancestors, depth + 1) ?? null
          } catch {
            return null
          }
        })
      }
      const result: [string, unknown][] = []
      for (const key of Object.getOwnPropertyNames(value)) {
        let child: unknown
        try {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The recursive converter is in the non-null object branch; own names index that same object.
          child = normalize((value as ApiObject)[key], ancestors, depth + 1)
        } catch {
          child = null
        }
        if (child !== undefined) {
          result.push([key.toWellFormed(), child])
        }
      }
      return Object.fromEntries(result)
    } finally {
      ancestors.delete(value)
    }
  }
  const toWire = (value: unknown): unknown => {
    if (areaName === 'session') {
      return normalize(value)
    }
    const json = JSON.stringify(value)
    return json === undefined ? undefined : JSON.parse(json)
  }
  // Why trim: Chrome ignores trailing undefined arguments; main's tuples would reject them.
  const splitCallback = (input: unknown[]): [unknown[], ExtensionCallable | undefined] => {
    let end = input.length
    while (end > 0 && input[end - 1] === undefined) {
      end -= 1
    }
    const last = input[end - 1]
    return isCallable(last) ? [input.slice(0, end - 1), last] : [input.slice(0, end), undefined]
  }
  // sync.onChanged's listeners, then one set per chrome/browser storage.onChanged wrapper.
  const areaListeners = new Set<ExtensionCallable>()
  const storageListeners: Set<ExtensionCallable>[] = []
  let listening = false
  // Why always with `forward`: content scripts hear other contexts' changes only through it.
  const syncListening = (): void => {
    const active =
      Boolean(forward) || [areaListeners, ...storageListeners].some((set) => set.size > 0)
    if (active !== listening) {
      listening = active
      bridge.listen(namespace, 'onChanged', active)
    }
  }
  const makeEvent = (registered: Set<ExtensionCallable>, inner: ApiObject | null): ApiObject => {
    const nativeListeners = new Map<ExtensionCallable, ExtensionCallable>()
    return {
      addListener: (callback: unknown) => {
        if (!isCallable(callback) || registered.has(callback)) {
          return
        }
        registered.add(callback)
        if (inner && isCallable(inner.addListener)) {
          const filtered: ExtensionCallable = (...args) => {
            if (areaName !== 'session' || args[1] !== 'session') {
              callback(...args)
            }
          }
          nativeListeners.set(callback, filtered)
          inner.addListener(filtered)
        }
        syncListening()
      },
      removeListener: (callback: unknown) => {
        if (!isCallable(callback) || !registered.delete(callback)) {
          return
        }
        const filtered = nativeListeners.get(callback)
        if (filtered && inner && isCallable(inner.removeListener)) {
          inner.removeListener(filtered)
        }
        nativeListeners.delete(callback)
        syncListening()
      },
      hasListener: (callback: unknown) => isCallable(callback) && registered.has(callback),
      hasListeners: () => registered.size > 0
    }
  }
  const deliver = (changes: ApiObject, from?: string): void => {
    const calls: [ExtensionCallable, unknown[]][] = [
      ...[...areaListeners].map((callback): [ExtensionCallable, unknown[]] => [
        callback,
        [changes]
      ]),
      ...storageListeners.flatMap((set) =>
        [...set].map((callback): [ExtensionCallable, unknown[]] => [callback, [changes, areaName]])
      )
    ]
    for (const [callback, callArgs] of calls) {
      try {
        callback(...callArgs)
      } catch (error) {
        console.error(error)
      }
    }
    forward?.(changes, from)
  }
  bridge.onEvent((eventNamespace, event, args) => {
    const [changes] = args
    if (eventNamespace === namespace && event === 'onChanged' && isObject(changes)) {
      deliver(changes)
    }
  })
  // Why writes deliver their own changes: a starting worker's write can reach main before its
  // listen does, and Chrome fires the writer's own listeners too. Main skips the caller.
  const writes = new Set(['set', 'remove', 'clear'])
  const method =
    (name: string) =>
    (...input: unknown[]): unknown => {
      const [args, callback] = splitCallback(input)
      const promise = (async () => {
        const reply = await bridge.call(namespace, name, args.map(toWire))
        if (!reply.ok) {
          throw new Error(reply.error)
        }
        if (!writes.has(name)) {
          return reply.value
        }
        if (isObject(reply.value) && Object.keys(reply.value).length > 0) {
          deliver(reply.value)
        }
        return undefined
      })()
      if (!callback) {
        return promise
      }
      promise.then(
        (value) => (value === undefined ? callback() : callback(value)),
        (error: unknown) =>
          callWithLastError(error instanceof Error ? error.message : String(error), () =>
            callback()
          )
      )
      return undefined
    }

  const area: ApiObject = {
    ...constants,
    // Why only the default: content scripts' relayed calls and change events are not restricted.
    setAccessLevel: (...input: unknown[]) => {
      const [[options], callback] = splitCallback(input)
      const supported =
        isObject(options) && options.accessLevel === 'TRUSTED_AND_UNTRUSTED_CONTEXTS'
      const error = 'This StorageArea is not available for setting access level'
      if (!callback) {
        return supported ? Promise.resolve() : Promise.reject(new Error(error))
      }
      void Promise.resolve().then(() =>
        supported ? callback() : callWithLastError(error, () => callback())
      )
      return undefined
    },
    onChanged: makeEvent(areaListeners, null)
  }
  if (areaName === 'session') {
    area.setAccessLevel = method('setAccessLevel')
  }
  for (const name of ['get', 'getKeys', 'getBytesInUse', 'set', 'remove', 'clear']) {
    area[name] = method(name)
  }
  const installed = new Set<object>()
  // Why `browser` too: it is a separate native global that WebExtension-style code reads first.
  for (const api of [chromeApi, root.browser]) {
    const storage = isObject(api) ? api.storage : null
    if (!isObject(storage) || installed.has(storage)) {
      continue
    }
    installed.add(storage)
    define(storage, areaName, area)
    const registered = new Set<ExtensionCallable>()
    storageListeners.push(registered)
    define(
      storage,
      'onChanged',
      makeEvent(registered, isObject(storage.onChanged) ? storage.onChanged : null)
    )
  }
  syncListening()
  const relayable = new Set(['get', 'getKeys', 'getBytesInUse', ...writes])
  // Why deliver here too: main skips this context's listeners for a write made on its behalf.
  return async (name, args, from) => {
    if (!relayable.has(name)) {
      return { ok: false, error: `storage.sync.${name} is not available here` }
    }
    const reply = await bridge.call(namespace, name, args.map(toWire))
    if (
      reply.ok &&
      writes.has(name) &&
      isObject(reply.value) &&
      Object.keys(reply.value).length > 0
    ) {
      deliver(reply.value, from)
    }
    return reply
  }
}
