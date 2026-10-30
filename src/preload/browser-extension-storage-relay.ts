import type { BrowserExtensionMainWorldBridge } from './browser-extension-main-world'

/** Main-only namespace carrying page storage writes to the worker; never installed on `chrome`. */
export const PRELOAD_STORAGE_RELAY_NAMESPACE = 'orcaStorageRelay'

export type BrowserExtensionStorageContext = 'page' | 'worker'

type ApiObject = Record<string, unknown>
type ExtensionCallable = (...args: unknown[]) => unknown
type StorageChanges = Record<string, { oldValue?: unknown; newValue?: unknown }>

/**
 * Electron never fires chrome.storage.onChanged in extension service workers. This wraps each
 * area's set/remove/clear to compute Chrome-shaped changes: a page reports them to main, which
 * forwards them to the same extension's worker; in a worker, onChanged becomes an Orca event fed by
 * those reports and the worker's own writes. Pages keep the native onChanged, which works.
 * Known gap: writes from content scripts (web pages' isolated worlds) never reach the worker.
 * Sync is not wrapped: Electron disables it and installBrowserExtensionStorageSync replaces it.
 *
 * Self-contained for the same reason as installBrowserExtensionApis: pages serialize it.
 */
export function installBrowserExtensionStorageRelay(
  bridge: BrowserExtensionMainWorldBridge,
  context: BrowserExtensionStorageContext
): void {
  const relayNamespace = 'orcaStorageRelay'
  const isObject = (value: unknown): value is ApiObject =>
    value !== null && typeof value === 'object'
  const isCallable = (value: unknown): value is ExtensionCallable => typeof value === 'function'
  const root: { chrome?: unknown; browser?: unknown } = globalThis
  const chromeApi = root.chrome
  if (!isObject(chromeApi) || !isObject(chromeApi.storage)) {
    return
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
  const lastErrorMessage = (): string | null => {
    const lastError = isObject(chromeApi.runtime) ? chromeApi.runtime.lastError : null
    return isObject(lastError) ? String(lastError.message ?? 'Storage error') : null
  }
  const diff = (before: ApiObject, after: ApiObject): StorageChanges => {
    const changes: StorageChanges = {}
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const had = Object.hasOwn(before, key)
      const has = Object.hasOwn(after, key)
      if (had && has && JSON.stringify(before[key]) === JSON.stringify(after[key])) {
        continue
      }
      changes[key] = {
        ...(had ? { oldValue: before[key] } : {}),
        ...(has ? { newValue: after[key] } : {})
      }
    }
    return changes
  }

  // Worker listeners by area name; '' holds chrome.storage.onChanged's.
  const listeners = new Map<string, Set<ExtensionCallable>>()
  let listening = false
  const deliver = (areaName: string, changes: ApiObject): void => {
    const calls: [ExtensionCallable, unknown[]][] = [
      ...[...(listeners.get(areaName) ?? [])].map((callback): [ExtensionCallable, unknown[]] => [
        callback,
        [changes]
      ]),
      ...[...(listeners.get('') ?? [])].map((callback): [ExtensionCallable, unknown[]] => [
        callback,
        [changes, areaName]
      ])
    ]
    for (const [callback, args] of calls) {
      try {
        callback(...args)
      } catch (error) {
        console.error(error)
      }
    }
  }
  const makeEvent = (areaName: string): ApiObject => {
    const registered = new Set<ExtensionCallable>()
    listeners.set(areaName, registered)
    // Why one wire listen for all storage events: main forwards one event carrying the area name.
    const syncListening = (): void => {
      const active = [...listeners.values()].some((set) => set.size > 0)
      if (active !== listening) {
        listening = active
        bridge.listen(relayNamespace, 'onChanged', active)
      }
    }
    return {
      addListener: (callback: unknown) => {
        if (isCallable(callback) && !registered.has(callback)) {
          registered.add(callback)
          syncListening()
        }
      },
      removeListener: (callback: unknown) => {
        if (isCallable(callback) && registered.delete(callback)) {
          syncListening()
        }
      },
      hasListener: (callback: unknown) => isCallable(callback) && registered.has(callback),
      hasListeners: () => registered.size > 0
    }
  }
  const publish = (areaName: string, changes: StorageChanges): void => {
    if (Object.keys(changes).length === 0) {
      return
    }
    if (context === 'worker') {
      deliver(areaName, changes)
    } else {
      void bridge.call(relayNamespace, 'report', [areaName, changes])
    }
  }

  // Keys a write touches (null: all), or undefined for a shape the native call should reject itself.
  const writeKeys: Record<string, (args: unknown[]) => string[] | null | undefined> = {
    set: ([items]) => (isObject(items) && !Array.isArray(items) ? Object.keys(items) : undefined),
    remove: ([keys]) =>
      typeof keys === 'string'
        ? [keys]
        : Array.isArray(keys) && keys.every((key) => typeof key === 'string')
          ? keys
          : undefined,
    clear: () => null
  }
  const wrapArea = (area: ApiObject, areaName: string): void => {
    const get = area.get
    if (!isCallable(get)) {
      return
    }
    for (const [method, keysOf] of Object.entries(writeKeys)) {
      const native = area[method]
      if (!isCallable(native)) {
        continue
      }
      define(area, method, function orcaStorageWrite(...input: unknown[]): unknown {
        const args = [...input]
        const last = args.at(-1)
        const callback = isCallable(last) ? last : undefined
        if (callback) {
          args.pop()
        }
        const keys = keysOf(args)
        if (keys === undefined) {
          return native.call(area, ...input)
        }
        // Why all three now: Chromium runs an area's calls in order, so the reads bracket exactly
        // this write, and the write copies its arguments at call time as Chrome's does.
        const run = (done: (error: string | null) => void): void => {
          let before: unknown
          let error: string | null = null
          get.call(area, keys, (value: unknown) => {
            before = value
          })
          native.call(area, ...args, () => {
            error = lastErrorMessage()
            if (error !== null) {
              // Why inside the native callback: chrome.runtime.lastError is set only here.
              done(error)
            }
          })
          get.call(area, keys, (after: unknown) => {
            if (error !== null) {
              return
            }
            done(null)
            if (isObject(before) && isObject(after)) {
              publish(areaName, diff(before, after))
            }
          })
        }
        if (callback) {
          run(() => callback())
          return undefined
        }
        return new Promise((resolve, reject) =>
          run((error) => (error === null ? resolve(undefined) : reject(new Error(error))))
        )
      })
    }
  }

  const wrapped = new WeakSet<object>()
  const events =
    context === 'worker'
      ? {
          onChanged: makeEvent(''),
          local: makeEvent('local'),
          session: makeEvent('session')
        }
      : null
  // Why `browser` too: it is a separate native global that WebExtension-style code reads first.
  for (const api of [chromeApi, root.browser]) {
    const storage = isObject(api) ? api.storage : null
    if (!isObject(storage)) {
      continue
    }
    for (const areaName of ['local', 'session'] as const) {
      const area = storage[areaName]
      if (!isObject(area) || wrapped.has(area)) {
        continue
      }
      wrapped.add(area)
      wrapArea(area, areaName)
      if (events) {
        define(area, 'onChanged', events[areaName])
      }
    }
    if (events) {
      define(storage, 'onChanged', events.onChanged)
    }
  }
  if (events) {
    bridge.onEvent((namespace, event, args) => {
      const [changes, areaName] = args
      if (
        namespace === relayNamespace &&
        event === 'onChanged' &&
        isObject(changes) &&
        typeof areaName === 'string'
      ) {
        deliver(areaName, changes)
      }
    })
  }
}
