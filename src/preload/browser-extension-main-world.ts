import type { BrowserExtensionSurface } from './browser-extension-api-surface'

export type BrowserExtensionInvokeReply =
  | { ok: true; value: unknown }
  | { ok: false; error: string }

/** Isolated-world functions handed to the page through contextBridge. */
export type BrowserExtensionMainWorldBridge = {
  call: (namespace: string, method: string, args: unknown[]) => Promise<BrowserExtensionInvokeReply>
  /** `filters` lists every listener's filter, or is omitted when one listener takes everything. */
  listen: (namespace: string, event: string, active: boolean, filters?: unknown[]) => void
  /** Adds a handler; every handler sees every event main delivers. */
  onEvent: (handler: (namespace: string, event: string, args: unknown[]) => void) => void
  /** Whether one listener's filter takes this event; runs in the isolated world. */
  passesFilter: (namespace: string, args: unknown[], filter: unknown) => boolean
}

type ApiObject = Record<string, unknown>
/** Extension-supplied callbacks and Chrome's native bindings: arguments are whatever the API passes. */
type ExtensionCallable = (...args: unknown[]) => unknown

/**
 * Pages run it through contextBridge.executeInMainWorld, which serializes the function: it must
 * not reference anything outside its own body (a test enforces this). Workers run it directly
 * from Orca's worker shim.
 *
 * Adds the surface's methods and events to `chrome`, mirrors them onto `browser`, and accepts both
 * callback and promise calls, setting chrome.runtime.lastError for failed callback calls.
 */
export function installBrowserExtensionApis(
  bridge: BrowserExtensionMainWorldBridge,
  surface: BrowserExtensionSurface
): void {
  const isObject = (value: unknown): value is ApiObject =>
    value !== null && typeof value === 'object'
  const isCallable = (value: unknown): value is ExtensionCallable => typeof value === 'function'
  const root: { chrome?: unknown; browser?: unknown } = globalThis
  const chromeApi = root.chrome
  if (!isObject(chromeApi)) {
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
      try {
        target[key] = value
      } catch {
        // Frozen native object: leave it.
      }
    }
  }
  const runtime = (): ApiObject | null => (isObject(chromeApi.runtime) ? chromeApi.runtime : null)
  const readManifest = (): ApiObject => {
    try {
      const getManifest = runtime()?.getManifest
      const manifest: unknown =
        typeof getManifest === 'function' ? getManifest.call(runtime()) : null
      return isObject(manifest) ? manifest : {}
    } catch {
      return {}
    }
  }
  /** Members may be dotted ('services.passwordSavingEnabled.get'); missing parents are created. */
  const lookupPath = (owner: ApiObject, path: string): { parent: ApiObject; leaf: string } => {
    const keys = path.split('.')
    const leaf = keys.pop() ?? path
    let parent = owner
    for (const key of keys) {
      const next = parent[key]
      if (isObject(next)) {
        parent = next
      } else {
        const created: ApiObject = {}
        define(parent, key, created)
        parent = created
      }
    }
    return { parent, leaf }
  }
  const defineAt = (owner: ApiObject, path: string, value: unknown): void => {
    const { parent, leaf } = lookupPath(owner, path)
    define(parent, leaf, value)
  }
  // Why: contextBridge drops ImageData's getter-backed fields, so action.setIcon would lose pixels.
  const toTransferable = (value: unknown, depth = 0): unknown => {
    if (typeof ImageData !== 'undefined' && value instanceof ImageData) {
      return { width: value.width, height: value.height, data: Array.from(value.data) }
    }
    if (
      depth < 2 &&
      isObject(value) &&
      Object.prototype.toString.call(value) === '[object Object]'
    ) {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, toTransferable(entry, depth + 1)])
      )
    }
    return value
  }
  const callWithLastError = (message: string, callback: () => void): void => {
    const target = runtime()
    let defined = false
    if (target) {
      try {
        Object.defineProperty(target, 'lastError', { configurable: true, get: () => ({ message }) })
        defined = true
      } catch {
        // Native lastError cannot be replaced here; the callback still runs.
      }
    }
    try {
      callback()
    } finally {
      if (defined && target) {
        try {
          delete target.lastError
        } catch {
          // ignore
        }
      }
    }
  }
  // Why callback style: MV2 native bindings do not return promises.
  const callNative = (owner: ApiObject, fn: unknown, args: unknown[]): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (!isCallable(fn)) {
        reject(new Error('Native API is unavailable'))
        return
      }
      fn.call(owner, ...args, (result: unknown) => {
        const lastError = runtime()?.lastError
        if (isObject(lastError)) {
          reject(new Error(String(lastError.message ?? 'Extension API error')))
        } else {
          resolve(result)
        }
      })
    })

  const makeMethod = (
    namespace: string,
    name: string,
    nativeOptions: { omitKeys?: string[]; nullOnError?: boolean } | undefined,
    nativeOwner: ApiObject,
    nativeFn: unknown,
    returnsCreatedId = false
  ) =>
    function browserExtensionMethod(...input: unknown[]): unknown {
      const args = [...input]
      // Why: Chrome ignores trailing undefined (setIcon(details, undefined)); main's tuples would not.
      while (args.length > 0 && args.at(-1) === undefined) {
        args.pop()
      }
      const last = args.at(-1)
      const callback = isCallable(last)
        ? (value?: unknown) => (value === undefined ? last() : last(value))
        : undefined
      if (callback) {
        args.pop()
      }
      // Why: contextMenus.create returns the item id synchronously, so it is chosen here.
      let createdId: unknown
      if (returnsCreatedId) {
        const properties = isObject(args[0]) ? args[0] : {}
        createdId =
          typeof properties.id === 'string' || typeof properties.id === 'number'
            ? properties.id
            : Math.floor(Math.random() * 2 ** 31)
        args[0] = Object.fromEntries(
          Object.entries({ ...properties, id: createdId }).filter(([, value]) => !isCallable(value))
        )
      }
      const run = async (): Promise<unknown> => {
        let callArgs = args
        if (nativeOptions && isCallable(nativeFn)) {
          const omit = nativeOptions.omitKeys ?? []
          const nativeArgs = args.map((arg, index) =>
            index === 0 && isObject(arg) && omit.length > 0
              ? Object.fromEntries(Object.entries(arg).filter(([key]) => !omit.includes(key)))
              : arg
          )
          const nativeCall = callNative(nativeOwner, nativeFn, nativeArgs)
          const nativeResult = await (nativeOptions.nullOnError
            ? nativeCall.catch(() => null)
            : nativeCall)
          callArgs = [...args, nativeResult]
        }
        const reply = await bridge.call(
          namespace,
          name,
          callArgs.map((arg) => toTransferable(arg))
        )
        if (!reply.ok) {
          throw new Error(reply.error)
        }
        return reply.value
      }
      const promise = run()
      if (returnsCreatedId && !callback) {
        promise.catch((error: unknown) =>
          console.error(`Unchecked runtime.lastError: ${String(error)}`)
        )
        return createdId
      }
      if (!callback) {
        return promise
      }
      promise.then(
        (value) => callback(value),
        (error: unknown) =>
          callWithLastError(error instanceof Error ? error.message : String(error), () =>
            callback()
          )
      )
      return createdId
    }

  // Listener functions (keys) → their filter (webNavigation UrlFilter list, webRequest RequestFilter).
  const listeners = new Map<string, Map<unknown, unknown>>()
  bridge.onEvent((namespace, event, args) => {
    const registered = listeners.get(`${namespace}.${event}`)
    if (!registered) {
      return
    }
    for (const [callback, filter] of registered) {
      if (isCallable(callback) && bridge.passesFilter(namespace, args, filter)) {
        try {
          callback(...args)
        } catch (error) {
          console.error(error)
        }
      }
    }
  })
  const makeEvent = (namespace: string, name: string): ApiObject => {
    const key = `${namespace}.${name}`
    const registered = listeners.get(key) ?? new Map<unknown, unknown>()
    listeners.set(key, registered)
    // Why only webRequest sends filters: it is the one high-volume event main pre-filters.
    const filtered = namespace === 'webRequest'
    const filtersToSend = (): unknown[] | undefined => {
      const filters = [...registered.values()]
      return filtered && filters.length > 0 && filters.every(isObject) ? filters : undefined
    }
    return {
      addListener: (callback: unknown, filter?: unknown) => {
        if (typeof callback !== 'function' || registered.has(callback)) {
          return
        }
        registered.set(callback, filter)
        if (registered.size === 1 || filtered) {
          bridge.listen(namespace, name, true, filtersToSend())
        }
      },
      removeListener: (callback: unknown) => {
        if (!registered.delete(callback)) {
          return
        }
        if (registered.size === 0) {
          bridge.listen(namespace, name, false)
        } else if (filtered) {
          bridge.listen(namespace, name, true, filtersToSend())
        }
      },
      hasListener: (callback: unknown) => registered.has(callback),
      hasListeners: () => registered.size > 0
    }
  }

  const manifest = readManifest()
  // Why optional too: Chrome adds a granted API without a reload; main refuses calls until granted.
  const permissions = [manifest.permissions, manifest.optional_permissions].flatMap((list) =>
    Array.isArray(list) ? list : []
  )
  for (const [namespace, spec] of Object.entries(surface)) {
    if (spec.permission && ![spec.permission].flat().some((name) => permissions.includes(name))) {
      continue
    }
    if (spec.manifestKey && !(spec.manifestKey in manifest)) {
      continue
    }
    const existing = chromeApi[namespace]
    const target: ApiObject = isObject(existing) ? existing : {}
    const members: [string, unknown][] = []
    for (const [name, method] of Object.entries(spec.methods)) {
      const { parent, leaf } = lookupPath(target, name)
      members.push([
        name,
        makeMethod(namespace, name, method.native, parent, parent[leaf], method.returnsCreatedId)
      ])
    }
    for (const name of spec.events) {
      members.push([name, makeEvent(namespace, name)])
    }
    for (const [name, value] of Object.entries(spec.constants ?? {})) {
      if (!(name in target)) {
        members.push([name, value])
      }
    }
    for (const [name, value] of members) {
      defineAt(target, name, value)
    }
    if (target !== existing) {
      define(chromeApi, namespace, target)
    }
    // Why: `browser` is a separate native global; WebExtension-style code reads it first.
    const browserApi = root.browser
    if (isObject(browserApi) && browserApi !== chromeApi) {
      const mirror = browserApi[namespace]
      if (isObject(mirror) && mirror !== target) {
        for (const [name, value] of members) {
          defineAt(mirror, name, value)
        }
      } else if (!isObject(mirror)) {
        define(browserApi, namespace, target)
      }
    }
  }
}
